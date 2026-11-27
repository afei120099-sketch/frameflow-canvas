/** Old IDs remain readable for history; retired models must never be silently replaced. */
export const LEGACY_H3_RETIRED_MESSAGE = '旧 H3 模型已按确认清理，稳定版、视频延长及原音轨锁定视频已停用；请明确选择终极版或快速版。历史结果仍可查看。';
export const H3_WORKFLOW_OPTIONS = [
  { id: "stable", label: "H3 · 稳定工作流（已停用）", detail: LEGACY_H3_RETIRED_MESSAGE, available: false },
  { id: "community-ultimate", label: "H3 · 终极版", detail: "图片参考已试渲 · 默认10步 · 自定义参数 / 文生 / 首尾帧 / 音色实验未试渲", available: true },
  { id: "community-dialogue", label: "H3 · 单采极速文戏", detail: "图片参考已试渲 · 默认5步 · 自定义参数 / 文生 / 首尾帧 / 音色实验未试渲", available: true },
  { id: "h3-extend", label: "H3 · 视频延长（已停用）", detail: LEGACY_H3_RETIRED_MESSAGE, available: false },
] as const;
export type CommunityWorkflowId = "community-ultimate" | "community-dialogue";
export function isCommunityWorkflow(id?: string): id is CommunityWorkflowId { return id === "community-ultimate" || id === "community-dialogue"; }
export function communitySettings(id: CommunityWorkflowId) { return id === "community-ultimate" ? { steps: 10, loraStrength: 0.75 } : { steps: 5, loraStrength: 1 }; }
/** Community graphs use T8 T2VA for empty inputs, not Ref2VA's mandatory-reference contract. */
export function communityInputMode(counts: {pictures:number;videos:number;audios:number}, keyframes = false): 't2va' | 'ref2va' {
  return !keyframes && counts.pictures === 0 && counts.videos === 0 && counts.audios === 0 ? 't2va' : 'ref2va';
}
export function communityInputProblem(input: { pictures: number; videos?: number; audios?: number; hasLastFrame?: boolean; guides?: number; keyframeCount?: number }): string | null {
  if (input.hasLastFrame && !input.keyframeCount) return "普通参考模式不锁定尾帧；请显式开启首尾帧实验。";
  // 🧪 h3_ultimate_guide: both community graphs share node 136 → BasicGuider 126, so time anchors work on either.
  if ((input.guides ?? 0) < 0 || (input.guides ?? 0) > 4) return "时间锚点最多4个。";
  if (input.videos) return "终极版和极速版暂未接入普通参考视频；请移除参考视频。旧视频延长已停用。";
  if ((input.audios ?? 0) < 0 || (input.audios ?? 0) > 3) return "参考声音最多3条（包含说话角色的主声音）。";
  const references = input.pictures - (input.keyframeCount ?? 0);
  if (input.pictures < 0 || references < 0 || references > 9) return "参考图最多9张（包含角色外观图）；首尾帧实验可另加首帧和尾帧。超过4张未试渲。无图片时走文生实验。";
  return null;
}
export function workflowOption(id?: string) { return H3_WORKFLOW_OPTIONS.find((item) => item.id === (id ?? "stable")); }
export function workflowBlockedReason(id?: string): string | null {
  const option = workflowOption(id);
  if (!option) return "工作流选择无法识别，请明确选择 H3 终极版或快速版；不会自动换成其他工作流。";
  if (option.available) return null;
  return LEGACY_H3_RETIRED_MESSAGE;
}
