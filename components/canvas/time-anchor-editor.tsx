"use client";
import { useRef } from "react";
import { ArrowDown, ArrowUp, ImagePlus, X } from "lucide-react";
import { checkTimeAnchors, timeAnchorFrame, H3_TIME_ANCHOR_MAX, H3_TIME_ANCHOR_NOTE } from "@/lib/comfyui/experimental/h3-ultimate-guide";
import { useImageThumbnail } from "./use-image-thumbnail";

/** One node time anchor. `storageReference` is the local image; the Asset is resolved at submission. */
export interface TimeAnchorProp { storageReference: string; filename: string; atSeconds: number; asReference?: boolean; assetId?: string }

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

function AnchorThumb({ src, name }: { src: string; name: string }) {
  const url = useImageThumbnail(src, 160).url;
  return url ? <img src={url} alt={name} decoding="async" /> : <span className="time-anchor-thumb-empty" />;
}

/**
 * 🧪 Time anchors for the ultimate / fast community workflows (h3_ultimate_guide). Seconds are
 * converted with round(seconds × 24); submission sorts by time, so list order is only for reading.
 */
export function TimeAnchorEditor({ anchors, durationSeconds, length, edges, reserved, disabled, onChange, onAddFile }: {
  anchors: TimeAnchorProp[]; durationSeconds: number; length: number;
  edges: { first: boolean; last: boolean };
  /** Director Stage anchors already using some of the 4 slots. */
  reserved: number;
  disabled: boolean;
  onChange: (next: TimeAnchorProp[]) => void;
  onAddFile: (file: File) => Promise<{ storageReference: string; filename: string }>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const free = H3_TIME_ANCHOR_MAX - reserved - anchors.length;
  let errors: string[] = [], warnings: string[] = [];
  if (anchors.length) {
    try { warnings = checkTimeAnchors(anchors.map((anchor, i) => ({ imageName: anchor.filename || `anchor-${i}`, frameIdx: timeAnchorFrame(anchor.atSeconds) })), length, edges).warnings; }
    catch (cause) { errors = (cause instanceof Error ? cause.message : String(cause)).split("\n"); }
  }
  const set = (index: number, patch: Partial<TimeAnchorProp>) => onChange(anchors.map((anchor, i) => i === index ? { ...anchor, ...patch } : anchor));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= anchors.length) return;
    const next = [...anchors]; [next[index], next[target]] = [next[target], next[index]]; onChange(next);
  };
  const suggest = () => {
    const used = anchors.map((anchor) => anchor.atSeconds);
    const step = durationSeconds / (anchors.length + reserved + 2);
    const at = Math.min(Math.max(1, (used.length ? Math.max(...used) : 0) + step), Math.max(1, durationSeconds - 1));
    return Math.round(at * 4) / 4;
  };
  return <section className="time-anchor-editor" data-testid="h3-time-anchors" onPointerDown={stop}>
    <div className="time-anchor-head">
      <span>时间锚点 🧪</span>
      <button type="button" disabled={disabled || free <= 0} title={free <= 0 ? `锚点合计最多 ${H3_TIME_ANCHOR_MAX} 个（含导演台锚点）` : "添加锚点图片"} onClick={(event) => { event.stopPropagation(); input.current?.click(); }}><ImagePlus size={13} />添加锚点</button>
    </div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file) return;
      const at = suggest();
      void onAddFile(file).then((stored) => onChange([...anchors, { ...stored, atSeconds: at }]));
    }} />
    {anchors.map((anchor, index) => <div className="time-anchor-row" key={`${anchor.storageReference}:${index}`}>
      <AnchorThumb src={anchor.storageReference} name={anchor.filename} />
      <div className="time-anchor-fields">
        <label><input type="number" min={0} max={durationSeconds} step={0.25} value={anchor.atSeconds} disabled={disabled} aria-label={`锚点 ${index + 1} 时间（秒）`} onChange={(event) => set(index, { atSeconds: Number(event.target.value) })} />秒 · 第 {timeAnchorFrame(anchor.atSeconds)} 帧</label>
        <label className="time-anchor-ref"><input type="checkbox" checked={Boolean(anchor.asReference)} disabled={disabled} onChange={(event) => set(index, { asReference: event.target.checked })} />同时作为参考图</label>
        <small title={anchor.filename}>{anchor.filename}</small>
      </div>
      <div className="time-anchor-actions">
        <button type="button" aria-label="上移" disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
        <button type="button" aria-label="下移" disabled={disabled || index === anchors.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
        <button type="button" aria-label="删除锚点" disabled={disabled} onClick={() => onChange(anchors.filter((_, i) => i !== index))}><X size={12} /></button>
      </div>
    </div>)}
    {errors.map((message) => <p key={message} className="time-anchor-error" role="alert">{message}</p>)}
    {warnings.map((message) => <p key={message} className="time-anchor-warning">{message}</p>)}
    <p className="time-anchor-note">{H3_TIME_ANCHOR_NOTE}锚点图不占 Picture 编号；勾选“同时作为参考图”才会参与编号并计入 9 张参考图。</p>
  </section>;
}
