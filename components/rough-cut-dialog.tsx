"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Film, Square, X } from "lucide-react";
import { formatClock, type FinalCutList, type FinalCutRow } from "@/lib/final-cut-list";
import { beginRoughCutRun, failRoughCut, FPS_REASONS, freezeRoughCut, roughCutSources, sameRoughCut, saveRoughCut, type RoughCutOutput, type RoughCutSnapshot } from "@/lib/rough-cut";
import { cancelRoughCutJob, createRoughCutJob, disposeRoughCutJob, planRoughCutJob, roughCutJobResult, roughCutJobStatus, RoughCutJobFailure, startRoughCutJob, uploadRoughCutSource, type RoughCutJobError, type RoughCutJobStatus, type RoughCutPlan } from "@/lib/rough-cut-client";
import { getLocalVideoBlob, storeLocalVideo } from "@/lib/local-video-store";
import { downloadSavedMedia } from "@/lib/media-download";
import type { AssetRecord, RunRecord } from "@/lib/production-records";
import { logEvent } from "@/lib/error-log";

/**
 * Phase 19: "生成粗剪" — hard-cut MP4 of the enabled Final Cut clips in the user's order, trimmed
 * to their in/out points and re-encoded to one format by local PyAV. Stage status only (no fake %).
 */

type Phase =
  | { kind: "blocked"; problems: string[] }
  | { kind: "preparing"; step: string }
  | { kind: "ready"; plan: RoughCutPlan; notice?: string }
  | { kind: "running"; step: string }
  | { kind: "done"; asset: AssetRecord; output: RoughCutOutput }
  | { kind: "failed"; error: RoughCutJobError; when: "prepare" | "render" }
  | { kind: "cancelled" };

const SIZE_OPTIONS: { value: string; label: string }[] = [
  { value: "first", label: "跟随第一段（默认）" }, { value: "largest", label: "跟随最大画布" },
  { value: "1920x1080", label: "1920×1080 横屏" }, { value: "1280x720", label: "1280×720 横屏" },
  { value: "1080x1920", label: "1080×1920 竖屏" }, { value: "720x1280", label: "720×1280 竖屏" }, { value: "1080x1080", label: "1080×1080 方形" },
];
const STAGE_NAMES: Record<string, string> = { probe: "读取素材信息", check: "检查入点 / 出点", clip: "裁切并统一格式", finalize: "写入文件" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asFailure = (cause: unknown): RoughCutJobError => cause instanceof RoughCutJobFailure ? cause.info : { code: "ROUGH_CUT_FAILED", message: cause instanceof Error ? cause.message : String(cause), clip: null, stage: null };

function stageText(status: RoughCutJobStatus) {
  const stage = status.stage;
  if (!stage) return "处理中";
  const count = stage.index && stage.total ? ` ${stage.index}/${stage.total}` : "";
  if (stage.stage === "clip") return `裁切并统一格式${count}${stage.title ? ` · ${stage.title}` : ""}（按顺序硬切拼接）`;
  return `${STAGE_NAMES[stage.stage] ?? stage.stage}${count}`;
}

export function RoughCutDialog({ list, rows, onClose, onReady, autoStart = false }: { autoStart?: boolean; list: FinalCutList; rows: readonly FinalCutRow[]; onClose: () => void; onReady: (asset: AssetRecord) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "preparing", step: "冻结成片序列" });
  const [sizePolicy, setSizePolicy] = useState("first");
  const latest = useRef({ list, rows });
  useEffect(() => { latest.current = { list, rows }; }, [list, rows]);
  const job = useRef<{ id: string; scriptVersion: string; snapshot: RoughCutSnapshot } | null>(null);
  const run = useRef<RunRecord | null>(null);
  const running = useRef(false);
  const autoStarted = useRef(false);
  const stopped = useRef(false);
  const preparing = useRef(false);

  const dropJob = useCallback(async () => { if (running.current) return; const current = job.current; job.current = null; if (current) await disposeRoughCutJob(current.id); }, []);

  /** Freeze → verify every source file exists → upload each distinct source once → read real media info. */
  const prepare = useCallback(async (policy: string, notice?: string) => {
    if (preparing.current || running.current || stopped.current) return;
    preparing.current = true;
    let ownedId: string | undefined;
    try {
    await dropJob();
    const frozen = freezeRoughCut(latest.current.list, latest.current.rows);
    if (!frozen.ok) { setPhase({ kind: "blocked", problems: frozen.problems }); return; }
    const { snapshot } = frozen;
    const sources = roughCutSources(snapshot);
    const blobs: Blob[] = [];
    const missing: string[] = [];
    for (const source of sources) {
      try { const blob = await getLocalVideoBlob(source.storageReference); if (!blob.size) throw new Error("empty"); blobs.push(blob); }
      catch { missing.push(`第${source.order}段素材已失效（视频文件不存在）`); }
    }
    if (missing.length) { setPhase({ kind: "blocked", problems: missing }); return; }
    try {
      const created = await createRoughCutJob(snapshot);
      ownedId = created.id;
      if (stopped.current) { await disposeRoughCutJob(created.id); return; }
      job.current = { id: created.id, scriptVersion: created.scriptVersion, snapshot };
      for (const [index, source] of sources.entries()) {
        if (stopped.current) { await disposeRoughCutJob(created.id); return; }
        setPhase({ kind: "preparing", step: `准备素材 ${index + 1}/${sources.length}` });
        await uploadRoughCutSource(created.id, source.sourceKey, blobs[index]);
      }
      setPhase({ kind: "preparing", step: "读取素材信息" });
      const plan = await planRoughCutJob(created.id, policy);
      if (!stopped.current) setPhase({ kind: "ready", plan, notice });
    } catch (cause) {
      if (ownedId) await disposeRoughCutJob(ownedId);
      if (job.current?.id === ownedId) job.current = null;
      if (!stopped.current) setPhase({ kind: "failed", error: asFailure(cause), when: "prepare" });
    }
    } finally { preparing.current = false; }
  }, [dropJob]);

  useEffect(() => {
    stopped.current = false;
    let mounted = true;
    // React effect replay must not launch two preparations sharing the same job ref.
    queueMicrotask(() => { if (mounted) void prepare("first"); });
    return () => {
      mounted = false;
      stopped.current = true;
      // Only the explicit Cancel button cancels an export. Delayed idle cleanup also
      // survives effect replay; the running controller still saves its final asset.
      queueMicrotask(() => { if (stopped.current && !running.current) void dropJob(); });
    };
  }, [prepare]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); if (!running.current) onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const replan = async (policy: string) => {
    setSizePolicy(policy);
    const current = job.current;
    if (!current || phase.kind !== "ready" || running.current || preparing.current) return;
    setPhase({ kind: "preparing", step: "读取素材信息" });
    try { setPhase({ kind: "ready", plan: await planRoughCutJob(current.id, policy) }); }
    catch (cause) { await dropJob(); setPhase({ kind: "failed", error: asFailure(cause), when: "prepare" }); }
  };

  const start = async () => {
    const current = job.current;
    if (!current || phase.kind !== "ready" || running.current || preparing.current) return;
    // The export uses exactly the list as it is now; edits made after preparing trigger a re-prepare.
    const fresh = freezeRoughCut(latest.current.list, latest.current.rows);
    if (!fresh.ok) { await dropJob(); setPhase({ kind: "blocked", problems: fresh.problems }); return; }
    if (!sameRoughCut(fresh.snapshot, current.snapshot) || fresh.snapshot.title !== current.snapshot.title) { await prepare(sizePolicy, "成片序列在准备后被修改，已按最新内容重新准备，请再确认一次"); return; }
    running.current = true;
    setPhase({ kind: "running", step: "读取素材信息" });
    try {
      run.current = await beginRoughCutRun(current.snapshot, { sizePolicy, scriptVersion: current.scriptVersion, plannedOutput: phase.plan.output });
      await startRoughCutJob(current.id, sizePolicy);
      let status: RoughCutJobStatus;
      for (;;) {
        await sleep(500);
        status = await roughCutJobStatus(current.id);
        if (status.state === "done") break;
        if (status.state === "failed") throw new RoughCutJobFailure(status.error ?? { code: "RENDER_FAILED", message: "粗剪失败", clip: null, stage: null });
        if (status.state === "cancelled") return;
        if (!stopped.current) setPhase({ kind: "running", step: stageText(status) });
      }
      setPhase({ kind: "running", step: "保存结果" });
      const output = status.result as unknown as RoughCutOutput;
      const video = await roughCutJobResult(current.id);
      const asset = await saveRoughCut({ run: run.current, snapshot: current.snapshot, output, video, store: storeLocalVideo });
      running.current = false;
      await dropJob();
      if (!stopped.current) { onReady(asset); setPhase({ kind: "done", asset, output }); }
    } catch (cause) {
      running.current = false;
      const error = asFailure(cause);
      if (run.current) await failRoughCut(run.current.runId, error.message).catch(() => {});
      await dropJob();
      void logEvent({ level: "error", category: "task", title: "粗剪失败", detail: [error.message, error.stage && `阶段：${error.stage}`, error.clip && `第${error.clip}段`, error.filename, error.logPath && `日志：${error.logPath}`, error.detail].filter(Boolean).join("\n") });
      if (!stopped.current) setPhase({ kind: "failed", error, when: "render" });
    }
  };

  useEffect(() => {
    if (autoStart && phase.kind === "ready" && !autoStarted.current) {
      autoStarted.current = true;
      void start();
    }
  });

  const cancel = async () => {
    const current = job.current;
    if (!current || !running.current) return;
    stopped.current = true;
    running.current = false;
    await cancelRoughCutJob(current.id);
    job.current = null;
    if (run.current) await failRoughCut(run.current.runId, "用户取消粗剪", true).catch(() => {});
    stopped.current = false;
    setPhase({ kind: "cancelled" });
  };

  const snapshot = job.current?.snapshot;
  const clipLabel = (position: number | null) => {
    const clip = position && snapshot ? snapshot.clips[position - 1] : null;
    return clip ? `第${clip.order}段（粗剪第 ${position} 段）“${clip.filename}”` : null;
  };
  const busy = phase.kind === "preparing" || phase.kind === "running";

  return createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="generation-info-panel ff-panel rough-cut-panel" role="dialog" aria-modal="true" aria-label="生成粗剪" onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small className="ff-hint">输出一个完整 MP4 · 按草稿的硬切／叠化／淡入淡出设置</small><h2>生成粗剪</h2></div>{!busy && <button type="button" aria-label="关闭生成粗剪" onClick={onClose}><X size={17} /></button>}</header>
      <div className="rough-cut-body">
        {phase.kind === "blocked" && <><p className="role-error">不能开始粗剪：</p><ul className="rough-cut-problems">{phase.problems.map((problem) => <li key={problem}>【{problem}】</li>)}</ul><p className="backup-note">请先在成片序列中修正或停用这些片段；粗剪不会自动跳过。</p></>}
        {phase.kind === "preparing" && <p className="rough-cut-stage"><Film size={15} />{phase.step}…</p>}
        {phase.kind === "ready" && snapshot && <>
          {phase.notice && <p className="role-notice">{phase.notice}</p>}
          <dl className="rough-cut-summary">
            <dt>启用片段</dt><dd>{snapshot.clips.length} 段{snapshot.disabled.length ? `（停用 ${snapshot.disabled.length} 段不进入粗剪）` : ""}</dd>
            <dt>预计成片时长</dt><dd>{formatClock(phase.plan.output.duration)}</dd>
            <dt>输出 FPS</dt><dd>{Number(phase.plan.output.fpsValue.toFixed(3))} FPS<small>{FPS_REASONS[phase.plan.output.fpsReason] ?? ""}</small></dd>
            <dt>输出尺寸</dt><dd><select value={sizePolicy} onChange={(event) => void replan(event.target.value)}>{SIZE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{phase.plan.output.width}×{phase.plan.output.height} · 保持比例不拉伸，空余处加黑边</small></dd>
            <dt>编码</dt><dd>全部重新编码为 H.264 + AAC 48kHz 立体声（稳定优先）<small>{phase.plan.output.unify.length ? phase.plan.output.unify.map((item) => `第${snapshot.clips[item.clip - 1]?.order ?? item.clip}段：${item.reasons.join("，")}`).join("；") : "所有片段规格一致，仍统一重新编码"}</small></dd>
          </dl>
          {phase.plan.warnings.length > 0 && <ul className="rough-cut-warnings">{phase.plan.warnings.map((warning) => <li key={warning}>△ {warning}</li>)}</ul>}
          <p className="ff-hint backup-note">原始素材不会被修改；成功后只新建一个“粗剪成片”视频并放到画布。</p>
        </>}
        {phase.kind === "running" && <><p className="rough-cut-stage"><Film size={15} />{phase.step}…</p><p className="ff-hint backup-note">本地 CPU（PyAV）处理，不使用 GPU；不显示估算百分比。</p></>}
        {phase.kind === "done" && <><p className="role-notice">粗剪完成，已放到画布：“{phase.asset.filename}”</p><dl className="rough-cut-summary"><dt>时长</dt><dd>{formatClock(phase.output.duration)}</dd><dt>尺寸</dt><dd>{phase.output.width}×{phase.output.height}</dd><dt>FPS</dt><dd>{Number(phase.output.fpsValue.toFixed(3))}</dd><dt>片段</dt><dd>{phase.output.clips.length} 段</dd></dl>{phase.output.warnings.length > 0 && <ul className="rough-cut-warnings">{phase.output.warnings.map((warning) => <li key={warning}>△ {warning}</li>)}</ul>}</>}
        {phase.kind === "failed" && <div className="rough-cut-failure"><p className="role-error">【粗剪失败】{phase.when === "prepare" ? "（准备阶段）" : ""}</p><dl className="rough-cut-summary">{clipLabel(phase.error.clip) && <><dt>片段</dt><dd>{clipLabel(phase.error.clip)}</dd></>}{phase.error.stage && <><dt>阶段</dt><dd>{STAGE_NAMES[phase.error.stage] ?? phase.error.stage}</dd></>}<dt>原因</dt><dd>{phase.error.message}</dd>{phase.error.detail && <><dt>PyAV 错误</dt><dd className="muted-id">{phase.error.detail}</dd></>}</dl><p className="backup-note">没有生成任何结果；原始素材未受影响。</p></div>}
        {phase.kind === "cancelled" && <p className="role-notice">已取消粗剪：临时文件已清理，没有生成结果。</p>}
      </div>
      <footer className="rough-cut-actions">
        {phase.kind === "ready" && <button type="button" className="role-main-action" onClick={() => void start()}><Film size={14} />开始生成粗剪</button>}
        {phase.kind === "running" && <button type="button" onClick={() => void cancel()}><Square size={13} />取消粗剪</button>}
        {phase.kind === "done" && <button type="button" onClick={() => void downloadSavedMedia(phase.asset.storageReference, phase.asset.filename, "video")}><Download size={14} />下载</button>}
        {(phase.kind === "failed" || phase.kind === "cancelled" || phase.kind === "blocked") && <button type="button" onClick={() => void prepare(sizePolicy)}>重新准备</button>}
        {!busy && <button type="button" onClick={onClose}>{phase.kind === "done" ? "完成" : "关闭"}</button>}
      </footer>
    </section>
  </div>, document.body);
}
