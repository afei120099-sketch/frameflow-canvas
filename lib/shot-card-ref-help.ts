// 镜头卡片「参考图」排不出来时，说人话：哪一项错了、是 JSON 的问题还是画布的问题、怎么改。
// 纯函数：卡片格子、复制给 AI 的文字、测试共用。能从正文「<Picture N>是X」推出是哪个角色时，把名字写出来。
import type { ShotQueueShot } from "./shot-queue.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const looksLikeId = (value: string) => ID.test(value.trim());

export interface RefProblem {
  /** json = 队列 JSON 写错了（让写队列的 AI 改）；canvas = 这个画布里缺东西（用户在画布里补） */
  owner: "json" | "canvas";
  /** 卡片格子里那一句 */
  short: string;
  /** 给 AI / 用户的完整改法 */
  fix: string;
}

type RoleLite = { roleId: string; displayName: string; primaryAppearanceAssetId?: string | null };
type AssetLite = { kind: string };

/** 正文里「<Picture N>是X」→ N → X（X 截到第一个标点 / 「只用于」之前）。 */
export function pictureNames(prompt: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const match of prompt.matchAll(/<Picture\s*(\d+)>\s*是\s*([^，,。；;：:\s（(<]+)/g)) {
    const name = match[2].replace(/只用于.*$/, "").trim();
    if (name && !out.has(Number(match[1]))) out.set(Number(match[1]), name);
  }
  return out;
}

const clip = (text: string, max = 24) => text.length > max ? `${text.slice(0, max)}…` : text;

/** roleIds 第 index 项在提交顺序里是第几张 Picture（场景在前、再出镜角色；首尾帧不占编号，正本写法）。画外角色没有图。 */
export function rolePictureNumber(shot: ShotQueueShot, index: number) {
  const roleId = shot.roleIds[index];
  if (shot.offscreenRoleIds?.includes(roleId)) return null;
  const visibleBefore = shot.roleIds.slice(0, index).filter((id) => !shot.offscreenRoleIds?.includes(id)).length;
  return shot.sceneAssetIds.length + visibleBefore + 1;
}

/** 这一镜所有 ID / 参考图问题（不只第一条）。没有问题返回 []。 */
export function referenceProblems(shot: ShotQueueShot, roles: readonly RoleLite[], assets: ReadonlyMap<string, AssetLite>): RefProblem[] {
  const out: RefProblem[] = [];
  const names = pictureNames(shot.prompt);
  shot.roleIds.forEach((value, index) => {
    const role = roles.find((item) => item.roleId === value);
    if (role) {
      if (!shot.offscreenRoleIds?.includes(value) && !role.primaryAppearanceAssetId) out.push({ owner: "canvas", short: `角色「${role.displayName}」没有主外观`, fix: `角色「${role.displayName}」没有主外观：请用户在画布角色库里给「${role.displayName}」选一张主外观图（不用改 JSON）。` });
      else if (role.primaryAppearanceAssetId && !shot.offscreenRoleIds?.includes(value) && assets.get(role.primaryAppearanceAssetId)?.kind !== "image") out.push({ owner: "canvas", short: `角色「${role.displayName}」的主外观图找不到`, fix: `角色「${role.displayName}」的主外观图不在这个画布的素材里：请用户在画布角色库里给它重新选一张主外观（不用改 JSON）。` });
      return;
    }
    const n = rolePictureNumber(shot, index);
    const who = n !== null ? names.get(n) : undefined;
    const known = who ? roles.find((item) => item.displayName === who) : undefined;
    const where = n !== null && who ? `正文里 <Picture ${n}> 是${who}：` : "";
    const fillWho = who ? `请填${who}在角色库里的 ID` : "请填这个角色在角色库里的 ID";
    const ifMissing = who ? `如果角色库里没有${who}，请告诉用户先在画布角色库里新建${who}、配好外观图，再把 ID 填进来。` : "如果角色库里没有这个角色，请告诉用户先在画布角色库里新建、配好外观图，再把 ID 填进来。";
    const knownId = known ? `（角色库里已经有${who}，ID 是 ${known.roleId}）` : "";
    if (!looksLikeId(value)) {
      out.push({ owner: "json", short: `roleIds 第 ${index + 1} 项不是角色 ID（写成了「${clip(value)}」）：请填${who ?? "角色"}在角色库里的 ID，没有这个角色先去角色库建`,
        fix: `roleIds 第 ${index + 1} 项不是角色 ID，而是一句描述「${clip(value, 40)}」。${where}${fillWho}${knownId}；${ifMissing}描述句不要放进 roleIds，放在正文里。` });
    } else {
      out.push({ owner: "canvas", short: `角色 ID 不在这个画布的角色库里（roleIds 第 ${index + 1} 项${who ? `，应是${who}` : ""}）`,
        fix: `roleIds 第 ${index + 1} 项「${value}」格式是 ID，但这个画布的角色库里没有${who ? `（正文里 <Picture ${n}> 是${who}）` : ""}。可能是别的画布的 ID 或抄错了：${known ? `角色库里的${who}是 ${known.roleId}，换成这个；` : ""}${ifMissing}` });
    }
  });
  shot.sceneAssetIds.forEach((value, index) => {
    const asset = assets.get(value);
    if (asset?.kind === "image") return;
    const n = index + 1, what = names.get(n);
    if (!looksLikeId(value)) out.push({ owner: "json", short: `sceneAssetIds 第 ${index + 1} 项不是素材 ID（写成了「${clip(value)}」）：请填场景图的 Asset ID`,
      fix: `sceneAssetIds 第 ${index + 1} 项不是素材 ID，而是「${clip(value, 40)}」。${what ? `正文里 <Picture ${n}> 是${what}：` : ""}请填这张场景图在画布素材库里的 Asset ID（卡片「JSON / 进度」里「当前画布角色和图片 ID」可以复制）；画布里还没有这张图，请告诉用户先导入。描述不要放进 sceneAssetIds，放在正文里。` });
    else out.push({ owner: "canvas", short: `素材 ID 不在这个画布里（sceneAssetIds 第 ${index + 1} 项${asset ? "不是图片" : ""}）`,
      fix: `sceneAssetIds 第 ${index + 1} 项「${value}」${asset ? "不是图片" : "不在这个画布的素材里"}${what ? `（正文里 <Picture ${n}> 是${what}）` : ""}：请用户把这张场景图导入画布，或者换成画布里已有的场景图 ID。` });
  });
  return out;
}

/** 参考图格子：一句人话 + 「这是 JSON 的问题 / 这是画布的问题」。refError 是 planShotReferences 抛的原文（鼠标停上去显示）。 */
export function referenceCellText(problems: readonly RefProblem[], refError: string) {
  const first = problems[0];
  if (!first) return refError ? { text: `参考图排不出来：${refError}`, owner: "", more: 0 } : null;
  return { text: first.short, owner: first.owner === "json" ? "这是 JSON 的问题" : "这是画布的问题", more: problems.length - 1 };
}
