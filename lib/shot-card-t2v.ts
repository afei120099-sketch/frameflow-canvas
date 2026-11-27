// 镜头卡片：没绑任何参考图的镜头按「文生视频（T2VA）」出片，画面全靠文字。参考图那一格改成「文生视频 · 画面描述」。
// 不另写规则：句子一律取自提示词完整度（lib/prompt-completeness.ts）已经定位到的证据，开场取 splitPromptLines 的第一个时间段。
import { splitPromptLines, type CategoryResult } from "./prompt-completeness.ts";
import type { CategoryId } from "./zhengben-categories.ts";
import type { ShotQueueShot } from "./shot-queue.ts";

export const T2V_NOTE = "🧪 文生视频还没真人验收；想和前后镜一致就绑场景图";
export const T2V_TITLE = "没有参考图时，画面由文字决定，场景和角色的样子可能和其他镜头对不上；想跟前后镜一致，就在 sceneAssetIds 里绑上场景图。";

/** 这一镜一张参考图都不交（没有场景图、没有出镜角色、没有首尾帧和锚点图）。 */
export function isTextToVideo(shot: ShotQueueShot) {
  const visibleRoles = shot.roleIds.filter((id) => !shot.offscreenRoleIds?.includes(id));
  return !shot.sceneAssetIds.length && !visibleRoles.length && !shot.firstFrameAssetId && !shot.lastFrameAssetId && !shot.firstFrameFrom && !shot.lastFrameFrom && !(shot.timeAnchors ?? []).some((anchor) => anchor.assetId);
}

const ROWS: { label: string; ids: CategoryId[] }[] = [
  { label: "风格", ids: ["style"] },
  { label: "场景", ids: ["scene", "props"] },
  { label: "镜头", ids: ["shotsize", "camera"] },
  { label: "光线", ids: ["light"] },
];

export interface T2vRow { label: string; lines: string[] }

/** 风格 / 场景 / 镜头 / 光线 / 开场，每类取完整度判「写到了」的那几句；没写的类别 lines 为空（卡片显示灰色「没写」）。 */
export function t2vDescription(shot: ShotQueueShot, results: readonly CategoryResult[] | undefined): T2vRow[] {
  const byId = new Map((results ?? []).map((result) => [result.id, result]));
  const rows = ROWS.map(({ label, ids }) => {
    const lines: string[] = [];
    for (const id of ids) { const result = byId.get(id); if (result?.state === "ok") for (const line of result.evidence) if (line && !lines.some((have) => have.includes(line) || line.includes(have))) lines.push(line); }
    return { label, lines };
  });
  const split = splitPromptLines(shot.prompt);
  const opening = split.beats[0]?.line ?? split.main[0];
  rows.push({ label: "开场", lines: opening ? [opening] : [] });
  return rows;
}
