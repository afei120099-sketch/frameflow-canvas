"use client";
import { useState, type ReactNode } from "react";
import { AssetPicker } from "@/components/role-library";
import { useImageThumbnail } from "@/components/canvas/use-image-thumbnail";
import type { AssetRecord } from "@/lib/production-records";
import { resolveOrderedStoryboardGuides, type StoryboardGuide } from "@/lib/storyboard-guides";

function GuideRow({ guide, disabled, onRemove }: { guide: StoryboardGuide; length: number; disabled: boolean; onChange: (guide: StoryboardGuide) => void; onRemove: () => void }) {
  const src = useImageThumbnail(guide.storageReference, 256).url;
  return <div className="storyboard-guide-row">
    {src && <img src={src} alt={guide.filename} decoding="async" draggable={false} />}
    <span title={guide.filename}>{guide.filename}</span>
    <button type="button" disabled={disabled} aria-label={`移除锚点 ${guide.filename}`} onClick={onRemove}>×</button>
  </div>;
}

export function StoryboardGuideEditor({ guides, totalCount, length, disabled, onChange, onUpload, firstSlot, referenceSlots = [], hideFirstSlot = false }: { guides: StoryboardGuide[]; totalCount: number; length: number; disabled: boolean; onChange: (guides: StoryboardGuide[]) => void; onUpload: (file: File) => Promise<AssetRecord>; firstSlot: ReactNode; referenceSlots?: ReactNode[]; hideFirstSlot?: boolean }) {
  const [picker, setPicker] = useState<number | null>(null);
  const slots = resolveOrderedStoryboardGuides(guides, length);
  const freeSlot = [0, 1, 2, 3].find((slot) => !slots.some((g) => g.slot === slot));
  const add = async (asset: AssetRecord) => {
    const previous = slots.find((g) => g.slot === picker);
    if (!previous && totalCount >= 4) throw new Error("引导锚点合计最多 4 个");
    if (guides.some((g) => g.assetId === asset.assetId && g.slot !== picker)) throw new Error("这张图片已加入锚点");
    onChange([...slots.filter((g) => g.slot !== picker), { assetId: asset.assetId, storageReference: asset.storageReference, filename: asset.filename, slot: picker ?? freeSlot ?? 0, anchorFrame: previous?.anchorFrame ?? Math.round((length - 1) * ((picker ?? 0) + 1) / 4), atEnd: previous?.atEnd ?? false }]);
    setPicker(null);
  };
  return <section className="h3-common-section storyboard-guide-editor" data-testid="storyboard-guides">
    <div className="setting-title"><span>顺序图片</span><span>最多 5 张 · 自动安排时间</span></div>
    <div className={`storyboard-slot-grid ${referenceSlots.length ? "has-references" : ""}`}>{!hideFirstSlot && firstSlot}{referenceSlots}{Array.from({ length: 4 }, (_, slot) => {
      const guide = slots.find((g) => g.slot === slot);
      if (referenceSlots.length && !guide && slot !== freeSlot) return null;
      return <div key={slot} className={`storyboard-slot ${guide ? "has-image" : ""}`} data-frame-role="guide" data-guide-slot={slot} aria-label={`分镜卡槽 ${slot + 1}`}>
        <button type="button" className="storyboard-slot-heading" disabled={disabled || (!guide && totalCount >= 4)} onClick={() => setPicker(slot)}>{guide?.atEnd ? "尾帧" : `图片 ${slot + 2}`}<small>{guide ? "点击更换" : "放入图片 / 拖线连接"}</small></button>
        {guide ? <GuideRow key={`${guide.assetId}:${guide.anchorFrame}:${guide.atEnd}`} guide={guide} length={length} disabled={disabled} onChange={(next) => onChange(slots.map((g) => g.slot === slot ? next : g))} onRemove={() => onChange(slots.filter((g) => g.slot !== slot))} /> : <button type="button" className="storyboard-empty" disabled={disabled || totalCount >= 4} onClick={() => setPicker(slot)}>＋</button>}
      </div>;
    })}</div>
    <p>{referenceSlots.length ? "普通参考图与全能参考共用；显示顺序不代表自动锁定时间或尾帧。需要指定顺序画面时，可另加分镜锚点。" : "按从左到右的顺序生成；空框忽略，最后一张自动作为结束画面。只需设置总时长。三张及以上使用实验引导，不保证精确命中或尾帧硬锁定。"}</p>
    {picker !== null && <AssetPicker kind="image" title="选择分镜锚点图片" onChoose={add} onUpload={async (file) => add(await onUpload(file))} onClose={() => setPicker(null)} />}
  </section>;
}
