export interface StoryboardGuide {
  assetId: string;
  storageReference: string;
  filename: string;
  anchorFrame: number;
  atEnd: boolean;
  slot?: number;
  sourceNodeId?: string;
}
export function resolveStoryboardGuides(guides: readonly StoryboardGuide[], length: number) {
  return guides.map((guide) => ({ ...guide, anchorFrame: guide.atEnd ? length - 1 : guide.anchorFrame })).sort((a, b) => a.anchorFrame - b.anchorFrame);
}
export function storyboardGuideProblem(guides: readonly { anchorFrame: number }[], length: number, mode: string | null) {
  if (!guides.length) return "";
  if (mode !== "i2va") return "分镜锚点需要首帧：请断开顶部尾帧、移除多参考素材及角色；结束画面请在锚点中设为‘结束’。";
  if (guides.length > 4) return "分镜与导演台引导锚点合计最多 4 个（不含首帧）。";
  if (guides.some((g) => !Number.isInteger(g.anchorFrame) || g.anchorFrame < 1 || g.anchorFrame >= length)) return "锚点时间超出当前视频，请调整时间或生成时长。";
  if (new Set(guides.map((g) => g.anchorFrame)).size !== guides.length) return "两个锚点不能使用相同时间，请调整时间；结束锚点只能有一个。";
  return "";
}
/** Occupied slots only, evenly timed; the final picture follows the end. */
export function resolveOrderedStoryboardGuides(guides: readonly StoryboardGuide[], length: number) {
  const ordered = guides.map((g, i) => ({ ...g, slot: g.slot ?? i })).sort((a, b) => a.slot - b.slot);
  return ordered.map((g, i) => ({ ...g, anchorFrame: Math.round((length - 1) * (i + 1) / ordered.length), atEnd: i === ordered.length - 1 }));
}
