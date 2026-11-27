"use client";
// 导演台顶部的 JSON 工具：复制给 AI 的说明 / 从 JSON 导入 / 导出 JSON / 撤销这次导入。
// 解析、校验、写入计划都在 lib/director-stage/import-format.ts；写入是 store.writeSceneBundles 一次事务。
// 确认用页面内对话框（不是 window.confirm）。只写导演台自己的数据库，不碰素材、镜头、H3、ComfyUI。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, FileJson, Undo2, Upload, X } from "lucide-react";
import { askConfirm } from "@/components/in-page-dialog";
import { copyPlainText } from "@/lib/copy-plain-text";
import { DIRECTOR_STAGE_GUIDE } from "@/lib/director-stage/import-guide";
import { describeImportPlan, exportDirectorStage, findConflicts, parseDirectorStageText, planDirectorStageImport, validateDirectorStageDocument, type ConflictChoice, type DirectorStageDocument, type ExistingScene, type SceneBundle, type ShotBindingRef } from "@/lib/director-stage/import-format";
import { writeSceneBundles } from "@/lib/director-stage/store";
import type { AssetRecord, ShotRecord } from "@/lib/production-records";

const backdrop: CSSProperties = { position: "fixed", inset: 0, zIndex: 100000, display: "grid", placeItems: "center", background: "rgba(0,0,0,.55)" };
const dialog: CSSProperties = { width: "min(760px,94vw)", maxHeight: "86vh", display: "flex", flexDirection: "column", gap: 10, overflow: "auto", padding: 18, border: "1px solid var(--ff-border-strong)", borderRadius: 12, background: "var(--ff-raised)", color: "var(--ff-text)", boxShadow: "var(--ff-shadow-lg)" };
const textarea: CSSProperties = { width: "100%", minHeight: 220, padding: 10, border: "1px solid var(--ff-border-strong)", borderRadius: 7, color: "var(--ff-text)", background: "var(--ff-surface)", font: "12px/1.5 var(--ff-mono)", resize: "vertical" };
const list: CSSProperties = { margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13 };
const row: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
const BAR: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", padding: "0 20px 12px" };

type Undo = { label: string; restore: SceneBundle[]; remove: string[] };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const shotRefs = (shots: ShotRecord[]): ShotBindingRef[] => shots.filter((shot) => shot.director).map((shot) => {
  const binding = shot.director!;
  return { label: `镜头 ${String(shot.shotNumber).padStart(2, "0")}${shot.title && shot.title !== `镜头 ${String(shot.shotNumber).padStart(2, "0")}` ? `「${shot.title}」` : ""}`, sceneId: binding.sceneId,
    ids: [binding.sceneStateId, binding.cameraId, ...binding.motionIds, binding.firstFramePackageId, binding.lastFramePackageId, binding.referencePackageId, ...binding.guidePackageIds].filter((id): id is string => Boolean(id)) };
});

export function DirectorStageJsonTools({ scenes, currentSceneId, assets, shots, disabled, onChanged, onOverlayChange }: {
  scenes: ExistingScene[] | null; currentSceneId: string | null; assets: AssetRecord[]; shots: ShotRecord[]; disabled: boolean;
  /** Called after an import or undo wrote data (the panel re-reads; `openSceneId` = scene to open, if any). */
  onChanged: (notice: string, openSceneId?: string) => Promise<void> | void;
  /** True while one of these dialogs is open, so the panel's Esc does not close the whole panel. */
  onOverlayChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<"import" | "export" | null>(null);
  const [copied, setCopied] = useState("");
  const [undo, setUndo] = useState<Undo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { onOverlayChange(mode !== null); }, [mode, onOverlayChange]);
  useEffect(() => {
    if (!mode) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); setMode(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, busy]);

  const copyGuide = () => { void copyPlainText(DIRECTOR_STAGE_GUIDE).then((ok) => { setCopied(ok ? "ok" : "fail"); window.setTimeout(() => setCopied(""), 2200); }); };
  const runUndo = async () => {
    if (!undo) return;
    const ok = await askConfirm({ title: "撤销这次导入？", message: `${undo.label}\n\n${undo.remove.length ? `会删除导入时新建的 ${undo.remove.length} 个场景（连同里面的道具、状态、摄影机、动作、素材包）。` : ""}${undo.restore.length ? `会把被覆盖的 ${undo.restore.length} 个场景恢复成导入前的样子。` : ""}\n导入之后在这些场景里做的修改（包括新生成的白模首帧素材包）也会一起撤掉；素材库里的图片不会被删除。`, confirmLabel: "撤销导入", danger: true });
    if (!ok) return;
    setBusy(true); setError("");
    try { await writeSceneBundles(undo.restore, undo.remove); setUndo(null); await onChanged("已撤销这次导入"); }
    catch (cause) { setError(`撤销失败：${message(cause)}`); }
    finally { setBusy(false); }
  };

  return <>
    <div style={BAR}>
      <button type="button" className="role-main-action" title="复制一份中文说明：字段表、坐标和单位、完整示例、常见错误。发给 AI，它就能直接写出导演台的 JSON" onClick={copyGuide}><Copy size={14} />{copied === "ok" ? "已复制说明" : copied === "fail" ? "复制失败" : "复制给 AI 的说明"}</button>
      <button type="button" className="role-main-action" disabled={disabled || busy || !scenes} title="粘贴 AI 写的 JSON 或选文件；先预览会新建 / 覆盖什么，确认后才写入" onClick={() => { setError(""); setMode("import"); }}><Upload size={14} />从 JSON 导入</button>
      <button type="button" className="role-main-action" disabled={!scenes?.length} title={currentSceneId ? "把这个场景导出成同样的格式，发给 AI 在上面改" : "把全部场景导出成同样的格式，发给 AI 在上面改"} onClick={() => setMode("export")}><FileJson size={14} />导出 JSON</button>
      {undo && <button type="button" className="role-main-action" disabled={busy} title={undo.label} onClick={() => void runUndo()}><Undo2 size={14} />撤销这次导入</button>}
    </div>
    {error && <p className="role-error" role="status">{error}</p>}
    {mode === "import" && scenes && createPortal(<ImportDialog scenes={scenes} assets={assets} shots={shots} onCancel={() => setMode(null)} onDone={async (result, notice, openSceneId) => { setUndo(result); setMode(null); await onChanged(notice, openSceneId); }} />, document.body)}
    {mode === "export" && scenes && createPortal(<ExportDialog scenes={currentSceneId ? scenes.filter((item) => item.scene.id === currentSceneId) : scenes} whole={!currentSceneId} onClose={() => setMode(null)} />, document.body)}
  </>;
}

function ImportDialog({ scenes, assets, shots, onCancel, onDone }: { scenes: ExistingScene[]; assets: AssetRecord[]; shots: ShotRecord[]; onCancel: () => void; onDone: (undo: Undo, notice: string, openSceneId?: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [document, setDocument] = useState<DirectorStageDocument | null>(null);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [copiedErrors, setCopiedErrors] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const assetKinds = useMemo(() => new Map(assets.map((asset) => [asset.assetId, asset.kind as string])), [assets]);
  const conflicts = useMemo(() => document ? findConflicts(document, scenes) : [], [document, scenes]);
  const undecided = conflicts.filter((item) => !choices[item.name]);
  const plan = useMemo(() => document && !undecided.length ? planDirectorStageImport(document, scenes, choices, { shots: shotRefs(shots) }) : null, [document, scenes, choices, shots, undecided.length]);

  const check = (value = text) => {
    setDocument(null); setChoices({}); setWriteError(""); setCopiedErrors(false);
    const parsed = parseDirectorStageText(value);
    if (!parsed.ok) { setErrors(parsed.errors); return; }
    const result = validateDirectorStageDocument(parsed.document, assetKinds);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors([]); setDocument(result.document);
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try { const value = await file.text(); setText(value); check(value); }
    catch (cause) { setErrors([`读不了这个文件：${message(cause)}`]); }
  };
  const confirm = async () => {
    if (!plan) return;
    setWriting(true); setWriteError("");
    try {
      await writeSceneBundles(plan.items.map((item) => item.bundle));
      const undo: Undo = { label: describeImportPlan(plan).filter((line) => !line.startsWith("⚠")).join("；"), restore: plan.items.flatMap((item) => item.action === "overwrite" && item.previous ? [item.previous] : []), remove: plan.items.filter((item) => item.action !== "overwrite").map((item) => item.bundle.scene.id) };
      const names = plan.items.map((item) => `“${item.finalName}”`).join("、");
      await onDone(undo, `已导入 ${plan.items.length} 个场景：${names}。不满意可以点「撤销这次导入」`, plan.items.length === 1 ? plan.items[0].bundle.scene.id : undefined);
    } catch (cause) { setWriteError(`写入失败，什么都没有改：${message(cause)}`); }
    finally { setWriting(false); }
  };

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return <div style={backdrop} onPointerDown={stop} onClick={stop} onWheel={stop}>
    <section role="dialog" aria-modal="true" aria-label="从 JSON 导入导演台场景" style={dialog}>
      <div style={{ ...row, justifyContent: "space-between" }}><h2 style={{ margin: 0, fontSize: 16 }}>从 JSON 导入</h2><button type="button" className="role-main-action" aria-label="关闭" disabled={writing} onClick={onCancel}><X size={14} /></button></div>
      <p className="role-hint" style={{ margin: 0 }}>把 AI 按「复制给 AI 的说明」写好的 director-stage-v1 JSON 粘到下面，或选一个 .json 文件。先检查、看清会改什么，再确认写入。</p>
      <textarea aria-label="导演台 JSON" style={textarea} spellCheck={false} placeholder='{"version":"director-stage-v1","scenes":[...]}' value={text} onChange={(event) => { setText(event.target.value); setDocument(null); setErrors([]); }} />
      <div style={row}>
        <button type="button" className="role-main-action" disabled={writing || !text.trim()} onClick={() => check()}>检查</button>
        <button type="button" className="role-main-action" disabled={writing} onClick={() => fileInput.current?.click()}><Upload size={14} />选择 .json 文件</button>
        <input ref={fileInput} type="file" accept=".json,application/json,text/plain" hidden onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ""; }} />
      </div>
      {errors.length > 0 && <div role="alert">
        <p style={{ margin: "0 0 6px", color: "var(--ff-bad)" }}>有 {errors.length} 处要改，改好再检查（没有写入任何东西）：</p>
        <ol style={{ ...list, color: "var(--ff-bad)" }}>{errors.map((line, index) => <li key={index}>{line}</li>)}</ol>
        <div style={{ ...row, marginTop: 8 }}><button type="button" className="role-main-action" onClick={() => { void copyPlainText(`导演台导入检查没通过，请按下面逐条改好，再给我完整的 JSON：\n${errors.map((line, index) => `${index + 1}. ${line}`).join("\n")}`).then(setCopiedErrors); }}><Copy size={14} />{copiedErrors ? "已复制" : "复制这些错误发给 AI"}</button></div>
      </div>}
      {document && <>
        {conflicts.length > 0 && <div style={{ display: "grid", gap: 6 }}>
          <b style={{ fontSize: 13 }}>这些场景画布里已经有了，选怎么处理：</b>
          {conflicts.map((item) => <div key={item.name} style={row} role="radiogroup" aria-label={`同名场景“${item.name}”怎么处理`}>
            <span style={{ minWidth: 120 }}>“{item.name}”</span>
            <label style={row}><input type="radio" name={`conflict-${item.name}`} checked={choices[item.name] === "overwrite"} onChange={() => setChoices((all) => ({ ...all, [item.name]: "overwrite" }))} />覆盖（改成 JSON 里的样子）</label>
            <label style={row}><input type="radio" name={`conflict-${item.name}`} checked={choices[item.name] === "copy"} onChange={() => setChoices((all) => ({ ...all, [item.name]: "copy" }))} />另存为新场景（原来的不动）</label>
          </div>)}
        </div>}
        {plan ? <div><b style={{ fontSize: 13 }}>确认后会：</b><ul style={list}>{describeImportPlan(plan).map((line, index) => <li key={index} style={line.startsWith("⚠") ? { color: "var(--ff-warn)" } : undefined}>{line}</li>)}</ul></div>
          : <p className="role-hint" style={{ margin: 0 }}>先给每个同名场景选「覆盖」或「另存」。</p>}
      </>}
      {writeError && <p style={{ margin: 0, color: "var(--ff-bad)" }} role="alert">{writeError}</p>}
      <div style={{ ...row, justifyContent: "flex-end" }}>
        <button type="button" className="role-main-action" disabled={writing} onClick={onCancel}>取消</button>
        <button type="button" className="role-main-action" style={{ background: "var(--ff-white)", color: "var(--ff-ink)", borderColor: "var(--ff-white)" }} disabled={!plan || writing} onClick={() => void confirm()}>{writing ? "正在写入…" : "确认导入"}</button>
      </div>
    </section>
  </div>;
}

function ExportDialog({ scenes, whole, onClose }: { scenes: ExistingScene[]; whole: boolean; onClose: () => void }) {
  const { document, notes } = useMemo(() => exportDirectorStage(scenes), [scenes]);
  const json = useMemo(() => JSON.stringify(document, null, 2), [document]);
  const [copied, setCopied] = useState("");
  const filename = `导演台-${whole ? "全部场景" : scenes[0]?.scene.name.replace(/[\\/:*?"<>|]/g, "_") ?? "场景"}.json`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = window.document.createElement("a");
    link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return <div style={backdrop} onPointerDown={stop} onClick={stop} onWheel={stop}>
    <section role="dialog" aria-modal="true" aria-label="导出导演台 JSON" style={dialog}>
      <div style={{ ...row, justifyContent: "space-between" }}><h2 style={{ margin: 0, fontSize: 16 }}>导出 JSON · {whole ? `全部 ${scenes.length} 个场景` : `场景“${scenes[0]?.scene.name}”`}</h2><button type="button" className="role-main-action" aria-label="关闭" onClick={onClose}><X size={14} /></button></div>
      <p className="role-hint" style={{ margin: 0 }}>把这份 JSON 和「复制给 AI 的说明」一起发给 AI，让它在上面改。改完导回来时选「覆盖」，每项的 id 原样保留就会更新同一条记录。</p>
      {notes.length > 0 && <ul style={{ ...list, color: "var(--ff-warn)" }}>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      <textarea aria-label="导出的导演台 JSON" readOnly style={textarea} value={json} />
      <div style={{ ...row, justifyContent: "flex-end" }}>
        <button type="button" className="role-main-action" onClick={() => { void copyPlainText(json).then((ok) => setCopied(ok ? "ok" : "fail")); }}><Copy size={14} />{copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制 JSON"}</button>
        <button type="button" className="role-main-action" onClick={download}><Download size={14} />下载 {filename}</button>
      </div>
    </section>
  </div>;
}
