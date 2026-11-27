"use client";
import { calculateH3Dimensions, H3_ASPECT_DIMENSIONS, H3_MIN_MEGAPIXELS, H3_MAX_MEGAPIXELS, type H3Aspect } from "@/lib/comfyui/h3-parameters";

export function H3ResolutionPicker({ aspect, sourceWidth, sourceHeight, megapixels, multiple, onChange }: {
  aspect: H3Aspect; sourceWidth: number; sourceHeight: number; megapixels: number; multiple: number; onChange: (value: number) => void;
}) {
  const size = H3_ASPECT_DIMENSIONS[aspect] ?? (sourceWidth && sourceHeight ? [sourceWidth, sourceHeight] : null);
  const current = calculateH3Dimensions(sourceWidth, sourceHeight, aspect, megapixels, multiple);
  return <section className="h3-common-section"><div className="setting-title"><span>生成分辨率</span><b>{current ? `${current.width}×${current.height}` : "跟随原图"}</b></div>
    <div className="mp-presets" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>{([480, 720] as const).map(p => {
      const requested = size ? p * p * Math.max(...size) / Math.min(...size) / (1024 * 1024) : null;
      const budget = requested === null ? null : Math.min(H3_MAX_MEGAPIXELS, Math.max(H3_MIN_MEGAPIXELS, requested));
      const dimensions = budget === null ? null : calculateH3Dimensions(sourceWidth, sourceHeight, aspect, budget, multiple);
      return <button type="button" key={p} disabled={budget === null} className={budget !== null && Math.abs(megapixels - budget) < 0.000001 ? "active" : ""} onClick={() => { if (budget !== null) onChange(budget); }}>{p}P<small>{dimensions ? `${dimensions.width}×${dimensions.height}` : "请先选择比例或连接原图"}</small></button>;
    })}</div><p>实际尺寸按工作流对齐规则生成，以上方尺寸为准；受原生像素预算上限约束。1080P 请从视频右侧＋选择“提升至1080P”。当前预算 {megapixels.toFixed(2)}MP。</p>
  </section>;
}
