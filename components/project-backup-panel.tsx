"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Download, Upload, X } from "lucide-react";
import { logEvent } from "@/lib/error-log";
import { collectProject, directorySink, exportProject, fileListSource, projectHasContent, readBackup, restoreProject, NIGHT_BACKUP_NOTE, type BackupManifest, type ParsedBackup, type RestoreReport } from "@/lib/project-backup";
import { DAILY_BACKUP_KEEP, dailyBackupFiles, listDailyBackups, readDailyBackup, type DailyBackupSummary } from "@/lib/daily-backup";
import { listDiskSnapshots, readDiskSnapshot, type DiskSnapshotSummary } from "@/lib/disk-snapshot";
import { isPersistent, persistenceLabel, type StoragePersistence } from "@/lib/storage-persistence";

type CanvasBridge = { current: () => unknown; load: (document: unknown) => void };
type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle> };
type State =
  | { kind: "idle" }
  | { kind: "exporting"; done: number; total: number; bytes: number }
  | { kind: "exported"; manifest: BackupManifest; folder: string }
  | { kind: "reading" }
  | { kind: "review"; parsed: ParsedBackup; hasContent: boolean; sourceKind?: "folder" | "daily" | "disk-snapshot"; snapshotFile?: string }
  | { kind: "restoring" }
  | { kind: "restored"; report: RestoreReport }
  | { kind: "error"; message: string; problems?: string[] };

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const stamp = (time: number) => { const d = new Date(time); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const STEP_NAMES = { media: "媒体文件", records: "Asset / Run / Shot 记录", roles: "角色", director: "导演台", canvas: "画布" } as const;

export function ProjectBackupPanel({ canvas, persistenceKey, appVersion, persistence, onClose }: { canvas: CanvasBridge; persistenceKey: string; appVersion: string; persistence: StoragePersistence | null; onClose: () => void }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [daily, setDaily] = useState<DailyBackupSummary[] | null>(null);
  const [snapshots, setSnapshots] = useState<DiskSnapshotSummary[] | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  useEffect(() => {
    if (state.kind !== "idle") return;
    let live = true;
    void listDailyBackups().then((rows) => { if (live) setDaily(rows); }).catch(() => { if (live) setDaily([]); });
    void listDiskSnapshots().then((rows) => { if (live) { setSnapshots(rows); setSnapshotError(""); } }).catch(() => { if (live) { setSnapshots([]); setSnapshotError("未连接到收件箱助手，暂无法读取硬盘快照"); } });
    return () => { live = false; };
  }, [state.kind]);
  const folderInput = useRef<HTMLInputElement>(null);
  const busy = state.kind === "exporting" || state.kind === "reading" || state.kind === "restoring";
  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); }, []);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, [busy, onClose]);

  const exportBackup = async () => {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) { setState({ kind: "error", message: "当前浏览器不支持导出到文件夹，请使用 Chrome 或 Edge 打开画布后再导出" }); return; }
    let root: FileSystemDirectoryHandle;
    try { root = await picker.call(window, { mode: "readwrite", id: "frameflow-backup" }); } catch { return; }
    const folder = `frameflow-backup-${stamp(Date.now())}`;
    setState({ kind: "exporting", done: 0, total: 0, bytes: 0 });
    try {
      const target = await root.getDirectoryHandle(folder, { create: true });
      const manifest = await exportProject(canvas.current(), directorySink(target), { appVersion, persistenceKey, onProgress: (done, total, bytes) => setState({ kind: "exporting", done, total, bytes }) });
      setState({ kind: "exported", manifest, folder });
    } catch (cause) { const detail = cause instanceof Error ? cause.message : String(cause); setState({ kind: "error", message: `导出失败：${detail}（当前项目未被修改）` }); void logEvent({ level: "error", category: "backup", title: "项目备份导出失败", detail }); }
  };
  const reviewDaily = (day: string) => {
    setState({ kind: "reading" });
    void (async () => {
      try { const parsed = await readDailyBackup(day); setState({ kind: "review", parsed, hasContent: projectHasContent(await collectProject(), canvas.current()), sourceKind: "daily" }); }
      catch (cause) { const problems = (cause as { problems?: string[] }).problems; setState({ kind: "error", message: cause instanceof Error ? cause.message : "每日备份读取失败", problems }); }
    })();
  };
  const reviewDiskSnapshot = (file: string) => {
    setState({ kind: "reading" });
    void (async () => {
      try {
        const parsed = await readDiskSnapshot(file);
        setState({ kind: "review", parsed, hasContent: projectHasContent(await collectProject(), canvas.current()), sourceKind: "disk-snapshot", snapshotFile: file });
      } catch (cause) {
        const problems = (cause as { problems?: string[] }).problems;
        setState({ kind: "error", message: cause instanceof Error ? cause.message : "硬盘快照读取失败", problems });
      }
    })();
  };
  const saveDaily = async (day: string) => {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) { setState({ kind: "error", message: "当前浏览器不支持存到文件夹，请使用 Chrome 或 Edge" }); return; }
    let root: FileSystemDirectoryHandle;
    try { root = await picker.call(window, { mode: "readwrite", id: "frameflow-backup" }); } catch { return; }
    try {
      const files = await dailyBackupFiles(day);
      if (!files) throw new Error(`找不到 ${day} 的每日备份`);
      const folder = `frameflow-daily-${day}`;
      const sink = directorySink(await root.getDirectoryHandle(folder, { create: true }));
      for (const [path, text] of Object.entries(files)) if (path !== "manifest.json") await sink.writeText(path, text);
      await sink.writeText("manifest.json", files["manifest.json"]);
      const manifest = JSON.parse(files["manifest.json"]) as BackupManifest;
      setState({ kind: "exported", manifest, folder });
    } catch (cause) { setState({ kind: "error", message: `存到文件夹失败：${cause instanceof Error ? cause.message : String(cause)}` }); }
  };
  const chooseFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? [...event.target.files] : [];
    event.target.value = "";
    if (!files.length) return;
    setState({ kind: "reading" });
    void (async () => {
      try {
        const parsed = await readBackup(fileListSource(files));
        setState({ kind: "review", parsed, hasContent: projectHasContent(await collectProject(), canvas.current()) });
      } catch (cause) {
        const problems = (cause as { problems?: string[] }).problems;
        setState({ kind: "error", message: cause instanceof Error ? cause.message : "备份读取失败", problems });
        void logEvent({ level: "error", category: "backup", title: "备份无法导入（已拒绝，未写入）", detail: problems?.length ? problems.join("\n") : cause instanceof Error ? cause.message : String(cause) });
      }
    })();
  };
  const restore = async (parsed: ParsedBackup) => {
    setState({ kind: "restoring" });
    try {
      const current = await collectProject();
      if (current.records.runs.some((run) => run.status === "queued" || run.status === "running")) throw new Error("请先等待或取消当前生成任务，再恢复项目；恢复时请勿在其他标签页编辑或开始任务");
      const report = await restoreProject(parsed, canvas);
      setState({ kind: "restored", report });
      void logEvent(report.ok ? { level: "info", category: "backup", title: "项目已从备份恢复", detail: report.steps.map((step) => `${step.step}: ${step.detail}`).join("\n") } : { level: "error", category: "backup", title: "备份恢复未完成", detail: [...report.steps.map((step) => `${step.ok ? "✓" : "✗"} ${step.step}: ${step.detail}`), report.rolledBack.length ? `已退回：${report.rolledBack.join("、")}` : "", report.rollbackFailed.length ? `未能退回：${report.rollbackFailed.join("、")}` : ""].filter(Boolean).join("\n") });
    }
    catch (cause) { const detail = cause instanceof Error ? cause.message : String(cause); setState({ kind: "error", message: `恢复在写入前失败：${detail}（当前项目未被修改）` }); void logEvent({ level: "error", category: "backup", title: "备份恢复在写入前失败", detail }); }
  };

  const counts = (manifest: BackupManifest) => <dl className="backup-counts">
    <dt>备份版本</dt><dd>{manifest.format} · v{manifest.formatVersion}</dd>
    <dt>导出时间</dt><dd>{new Date(manifest.exportedAt).toLocaleString("zh-CN")}</dd>
    <dt>媒体</dt><dd>图片 {manifest.counts.images} · 视频 {manifest.counts.videos} · 声音 {manifest.counts.audios} · 共 {mb(manifest.totalMediaBytes)}</dd>
    <dt>记录</dt><dd>Asset {manifest.counts.assets} · Run {manifest.counts.runs} · Shot {manifest.counts.shots} · 角色 {manifest.counts.roles}</dd>
    <dt>导演台</dt><dd>{manifest.directorCounts ? `场景 ${manifest.directorCounts.scenes} · 道具 ${manifest.directorCounts.props} · 状态 ${manifest.directorCounts.states} · 摄影机 ${manifest.directorCounts.cameras} · 动作 ${manifest.directorCounts.motions} · 控制素材包 ${manifest.directorCounts.controlPackages}` : "旧版备份，不含导演台数据"}</dd>
  </dl>;
  const warnings = (items: string[]) => items.length ? <ul className="backup-warnings">{items.map((item) => <li key={item}>{item}</li>)}</ul> : null;

  return createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="generation-info-panel backup-panel" role="dialog" aria-modal="true" aria-label="项目备份" onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small>本地文件夹 · 不上传</small><h2>项目备份</h2></div><button type="button" aria-label="关闭项目备份" disabled={busy} onClick={onClose}><X size={17} /></button></header>
      <div className="backup-body">
        {state.kind === "idle" && <>
          <p className="ff-hint">浏览器项目备份包含画布、Asset / Run / Shot / 角色记录、导演台数据和浏览器内的图片、视频、声音文件。</p>
          <p className="ff-hint backup-note">{NIGHT_BACKUP_NOTE}。夜班归档：在项目目录运行 node scripts/archive-autopilot.mjs --destination &quot;备份目标目录&quot;，使用双备份。</p>
          <div className="backup-actions"><button type="button" className="role-main-action" onClick={() => void exportBackup()}><Download size={15} />导出项目备份</button><button type="button" className="backup-secondary" onClick={() => folderInput.current?.click()}><Upload size={15} />从备份文件夹恢复</button></div>
          <p className="ff-hint backup-note">恢复前逐一校验同 ID 媒体的 hash、大小和 MIME；冲突拒绝写入。恢复期间媒体写入锁定，请勿在其他标签页操作。</p>
          <p className={persistence === null || isPersistent(persistence) ? "ff-hint backup-note" : "role-error"}>{persistenceLabel(persistence)}</p>
          <h3 className="backup-daily-title">每日自动备份（存在本浏览器里，不含图片 / 视频 / 声音，保留最近 {DAILY_BACKUP_KEEP} 天）</h3>
          {daily === null ? <p className="ff-hint">正在读取…</p> : daily.length === 0 ? <p className="ff-hint">还没有。打开画布约 1 分钟后会自动做今天的一份（画布为空时不做）。</p> : <ul className="backup-steps backup-daily-list">{daily.map((row) => <li key={row.day}>
            <span>{row.day} {new Date(row.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · Asset {row.manifest.counts.assets} · 镜头 {row.manifest.counts.shots} · 角色 {row.manifest.counts.roles} · {mb(row.bytes)}</span>
            <span className="backup-actions"><button type="button" className="backup-secondary" onClick={() => reviewDaily(row.day)}>用这份恢复…</button><button type="button" className="backup-secondary" onClick={() => void saveDaily(row.day)}>存到文件夹</button></span>
          </li>)}</ul>}
          <p className="ff-hint backup-note">每日备份只防「画布或记录被改坏 / 误删」。浏览器数据整个被清掉时它也会一起没，所以重要节点仍要「导出项目备份」到硬盘。</p>
          <h3 className="backup-daily-title">从硬盘快照恢复（每 10 分钟自动写入硬盘，保留最近 30 份）</h3>
          {snapshots === null ? <p className="ff-hint">正在读取硬盘快照列表…</p> : snapshotError ? <p className="ff-hint backup-note">{snapshotError}</p> : snapshots.length === 0 ? <p className="ff-hint">还没有硬盘快照（画布有内容后每 10 分钟自动生成）。</p> : <ul className="backup-steps backup-daily-list">{snapshots.map((row) => <li key={row.file}>
            <span>{row.file} · {new Date(row.mtime).toLocaleString("zh-CN")} · {row.size >= 1024 * 1024 ? mb(row.size) : `${(row.size / 1024).toFixed(1)} KB`}</span>
            <span className="backup-actions"><button type="button" className="backup-secondary" onClick={() => reviewDiskSnapshot(row.file)}>用这份恢复…</button></span>
          </li>)}</ul>}
        </>}
        {state.kind === "exporting" && <p><Archive size={15} /> 正在导出… 媒体 {state.done}/{state.total || "…"} · 已写入 {mb(state.bytes)}</p>}
        {state.kind === "exported" && <><p className="role-notice">导出完成：文件夹 “{state.folder}”</p>{counts(state.manifest)}{warnings(state.manifest.warnings)}<button type="button" className="backup-secondary" onClick={() => setState({ kind: "idle" })}>完成</button></>}
        {state.kind === "reading" && <p>正在读取并校验备份…</p>}
        {state.kind === "review" && <>
          {counts(state.parsed.manifest)}
          {warnings(state.parsed.warnings)}
          {state.sourceKind === "disk-snapshot" ? <p className="role-error">确认从硬盘快照「{state.snapshotFile}」恢复：会覆盖当前画布布局和记录，视频图片不受影响。如果某个素材之后被删掉了，画布上对应节点会显示缺失。</p> : state.parsed.manifest.lightweight && <p className="ff-hint backup-note">这是每日轻量备份：只恢复画布和记录；浏览器里现有的图片、视频、声音保持不变。如果某个素材之后被删掉了，画布上对应节点会显示缺失。</p>}
          {state.hasContent ? <p className="role-error">当前项目已有内容。覆盖恢复会用备份替换当前画布、Asset / Run / Shot 记录、角色和导演台数据（旧版备份不含导演台数据时保持当前导演台数据不变）；当前的媒体文件不会被删除。建议先导出当前项目。</p> : <p>当前项目为空，将直接恢复。</p>}
          <p className="ff-hint backup-note">导出时仍在进行的任务会恢复为“状态待确认”的历史记录，不会重新提交到 ComfyUI。</p>
          <div className="backup-actions"><button type="button" className="backup-secondary" onClick={() => setState({ kind: "idle" })}>取消</button><button type="button" className="role-main-action" onClick={() => void restore(state.parsed)}>{state.hasContent ? "覆盖恢复" : "恢复"}</button></div>
        </>}
        {state.kind === "restoring" && <p>正在恢复…请勿关闭页面</p>}
        {state.kind === "restored" && <>
          <p className={state.report.ok ? "role-notice" : "role-error"}>{state.report.ok ? "恢复完成。建议稍等两秒后刷新页面，让所有面板重新读取记录。" : "恢复未完成，已尝试退回到恢复前的状态。"}</p>
          <ul className="backup-steps">{state.report.steps.map((step) => <li key={step.step} className={step.ok ? "ok" : "failed"}>{step.ok ? "✓" : "✗"} {STEP_NAMES[step.step]}：{step.detail}</li>)}</ul>
          {state.report.rolledBack.length > 0 && <p className="backup-note">已退回：{state.report.rolledBack.map((step) => STEP_NAMES[step as keyof typeof STEP_NAMES]).join("、")}（恢复中写入的媒体文件保留，不影响当前项目）</p>}
          {state.report.rollbackFailed.length > 0 && <p className="role-error">以下部分未能退回，请用恢复前导出的备份再次恢复：{state.report.rollbackFailed.map((step) => STEP_NAMES[step as keyof typeof STEP_NAMES]).join("、")}</p>}
          <div className="backup-actions">{state.report.ok && <button type="button" className="role-main-action" onClick={() => window.setTimeout(() => window.location.reload(), 2000)}>两秒后刷新页面</button>}<button type="button" className="backup-secondary" onClick={onClose}>关闭</button></div>
        </>}
        {state.kind === "error" && <><p className="role-error">{state.message}</p>{state.problems && state.problems.length > 1 && warnings(state.problems)}<button type="button" className="backup-secondary" onClick={() => setState({ kind: "idle" })}>返回</button></>}
        <input ref={folderInput} type="file" hidden multiple onChange={chooseFolder} />
      </div>
    </section>
  </div>, document.body);
}
