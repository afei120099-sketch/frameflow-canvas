"use client";
import { useEffect, useRef, useState } from "react";
import { auditWarnings, contactSheet, downloadProductionFile, inspectVideo, referenceAnalysisTask, type MediaAuditReport } from "@/lib/media-audit";
import { getLocalVideoBlob } from "@/lib/local-video-store";
import type { AssetRecord } from "@/lib/production-records";

export function MediaAuditPanel({ asset, onNotes }: { asset?: AssetRecord | null; onNotes?: (text: string) => void }) {
  const [file, setFile] = useState<File | null>(null), [report, setReport] = useState<MediaAuditReport | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notes, setNotes] = useState(""), [task, setTask] = useState("");
  const [duration, setDuration] = useState(""), [audio, setAudio] = useState("any");
  const abort = useRef<AbortController | null>(null), epoch = useRef(0);
  useEffect(() => { abort.current?.abort(); }, [asset?.assetId, asset?.storageReference]);
  useEffect(() => () => { epoch.current++; abort.current?.abort(); }, []);
  const [source, setSource] = useState("");
  const identity = asset ? JSON.stringify([asset.assetId, asset.storageReference, asset.fileSize, asset.duration]) : file?.name ?? "";
  const current = source === identity ? report : null;
  const scan = async () => {
    if (busy) return; const token = ++epoch.current; const controller = new AbortController(); abort.current = controller; setBusy(true); setError(""); setReport(null);
    try { const blob = asset ? await getLocalVideoBlob(asset.storageReference) : file; if (!blob) throw new Error("请选择视频"); const result = await inspectVideo(blob, controller.signal); if (epoch.current === token) { setReport(result); setSource(identity); } }
    catch (e) { if (epoch.current === token) setError(e instanceof Error ? e.message : "检查失败"); }
    finally { if (epoch.current === token) setBusy(false); }
  };
  return <details className="production-tool">
    <summary>{onNotes ? "参考视频：抽帧与制作分析" : "视频基础质检"}</summary>
    <p className="ff-hint backup-note">本机 CPU 检查，不上传到 AI、不启动生成。完整解码、时长、音轨和近黑画面检测；变形、台词、表演仍需人工判断。上限 1GB / 10分钟。</p>
    {asset ? <p>当前素材：{asset.filename}</p> : <input aria-label="参考视频文件" type="file" accept="video/*" disabled={busy} onChange={(e) => { epoch.current++; setFile(e.target.files?.[0] ?? null); setReport(null); setTask(""); setNotes(""); setError(""); }} />}
    <button type="button" disabled={busy || (!asset && !file)} onClick={() => void scan()}>{busy ? "CPU 检查中…" : "检查并抽帧"}</button>
    {busy && <button type="button" onClick={() => abort.current?.abort()}>取消检查</button>}
    {error && <p role="alert">{error}</p>}
    {current && <>
      <p>{current.width}×{current.height} · {current.fps.toFixed(2)} FPS · {current.decodedDuration} 秒 · {current.frames} 帧 · {current.hasAudio ? "有音轨" : "未解码到音轨"}</p>
      <label>目标秒数（可选）<input type="number" min="0" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
      <label>声音要求<select value={audio} onChange={(e) => setAudio(e.target.value)}><option value="any">不限</option><option value="yes">有声音</option><option value="no">静音</option></select></label>
      <ul>{auditWarnings(current, Number(duration) || undefined, audio === "any" ? undefined : audio === "yes").map((text) => <li key={text}>△ {text}</li>)}</ul>
      <p className="ff-hint">解码完成不等于作品质量通过；近黑检测可能把夜景、淡出当作提醒。</p>
      <div className="production-samples">{current.samples.map((s, i) => <figure key={i}>{/* Local data URLs from CPU inspection; never remote image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={s.image} alt={`${s.time} 秒抽帧`} /><figcaption>{s.time} 秒</figcaption></figure>)}</div>
      <button type="button" onClick={() => void contactSheet(current).then((blob) => downloadProductionFile(blob, "reference-contact-sheet.png")).catch((e) => setError(String(e)))}>下载抽帧拼图</button>
      <button type="button" onClick={() => downloadProductionFile(new Blob([JSON.stringify({ source: asset?.assetId ?? file?.name, report: current, notes }, null, 2)], { type: "application/json" }), "media-audit-report.json")}>下载检查报告</button>
      {onNotes && <>
        <label className="autopilot-field"><span>参考视频观察 / GPT、Claude 分析结果（人工核对后填写）</span><textarea rows={3} maxLength={3000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <button type="button" onClick={() => { const text = referenceAnalysisTask(current, notes); setTask(text); void navigator.clipboard.writeText(text).catch(() => setError("请手动复制下面的任务")); }}>复制分析任务（另附抽帧拼图）</button>
        {task && <textarea aria-label="参考视频分析任务" rows={3} readOnly value={task} />}
        <button type="button" disabled={!notes.trim()} onClick={() => onNotes(notes)}>将核对后的参考建议用于章节规划</button>
      </>}
    </>}
  </details>;
}
