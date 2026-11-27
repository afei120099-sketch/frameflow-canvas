/**
 * 镜头卡片「放大看视频」的顺序和标签（纯函数，组件在 components/shot-card-video-viewer.tsx）。
 * 「上一条 / 下一条」按卡片里镜头的先后走，每镜一条：当前显示的那条（已采用的，没有就最新的，同 pickChosenVersion）；
 * 没出过视频的镜头跳过。同一镜的 A/B/C 和去配乐版只在放大层里用小标签切换，不改「已采用」。
 */

export interface ViewerVersion {
  assetId: string;
  /** A / B / C …（和视频列一样） */
  label: string;
  stale: boolean;
  adopted: boolean;
  /** 0 = 原声版；1 = 去配乐；2 = 去配乐 ×2 */
  demixPasses: number;
  /** 去配乐版对应的原声版 */
  sourceVideoAssetId?: string;
  /** 原片字母（去配乐版跟原片同一个字母，不占新字母）；没给时按 label */
  letter?: string;
  /** 是 A/B/C 切换上的那个字母（原片）；没给时原声版算 */
  owner?: boolean;
}

export interface ViewerShot<V extends ViewerVersion = ViewerVersion> {
  key: string;
  title: string;
  code: string;
  name: string;
  /** 视频列当前显示的那条；null = 没有视频 */
  chosenId: string | null;
  versions: V[];
}

/** 有视频的镜头，按卡片顺序。 */
export function viewerSequence<S extends ViewerShot>(shots: S[]): S[] {
  return shots.filter((shot) => shot.chosenId && shot.versions.some((version) => version.assetId === shot.chosenId));
}

/** 当前这一镜在顺序里的位置和前后两镜；在头 / 尾时对应一侧为 null（按钮变灰）。 */
export function viewerNav(sequence: ViewerShot[], title: string): { index: number; prev: string | null; next: string | null } {
  const index = sequence.findIndex((shot) => shot.title === title);
  if (index < 0) return { index, prev: null, next: null };
  return { index, prev: sequence[index - 1]?.title ?? null, next: sequence[index + 1]?.title ?? null };
}

/** 放大层的按键：← 上一条，→ 下一条，Esc 关闭。 */
export function viewerKey(key: string): "prev" | "next" | "close" | null {
  return key === "ArrowLeft" ? "prev" : key === "ArrowRight" ? "next" : key === "Escape" ? "close" : null;
}

/** 小标签上的字：「B」或「C · B 的去配乐版」。 */
export function versionTag(version: ViewerVersion, versions: ViewerVersion[]): string {
  if (!version.demixPasses) return version.label;
  // 卡片给了 letter：label 已经是「A · 去配乐」（去配乐版不占新字母）
  if (version.letter) return version.label;
  const root = versions.find((item) => item.assetId === version.sourceVideoAssetId);
  const kind = version.demixPasses > 1 ? `去配乐 ×${version.demixPasses} 版` : "去配乐版";
  return root ? `${version.label} · ${root.label} 的${kind}` : `${version.label} · ${kind}`;
}

/** 放大层上方那一行的状态：已采用 / 最新 / 旧提示词，加上原声或去配乐。 */
export function versionStatus(version: ViewerVersion, chosenId: string | null): string {
  const pick = version.adopted ? "★ 已采用" : version.assetId === chosenId ? "最新" : "候选";
  const sound = version.demixPasses ? (version.demixPasses > 1 ? `去配乐 ×${version.demixPasses} 版` : "去配乐版") : "原声版";
  return [pick, sound, ...(version.stale ? ["旧提示词出的"] : [])].join(" · ");
}

/** 一张参考图：tag = P1 / P2 …（和提交编号一致），group = 场景 / 角色。roleId = 角色图的角色 ID；assetId = 图片素材 ID。 */
export interface ViewerRef { tag: string; group: string; name: string; src: string; roleId?: string; assetId?: string }

/**
 * 参考图要显示、能复制的 ID（2026-11-12 用户：「这个上面带上图片ID，还要能复制」「角色也是的」）。
 * 角色图：角色 ID（roleIds 里填的那个）在前，外观图的图片 ID 在后；场景等其他图：图片 ID（sceneAssetIds 里填的那个）。
 */
export function refIds(ref: Pick<ViewerRef, "roleId" | "assetId">): { kind: string; id: string }[] {
  return [...(ref.roleId ? [{ kind: "角色 ID", id: ref.roleId }] : []), ...(ref.assetId ? [{ kind: "图片 ID", id: ref.assetId }] : [])];
}
/** 长 ID 截中间：「c68aa343…2fc30bef7df0」，悬停看全文。 */
export function clipMiddle(id: string, head = 8, tail = 12): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** 卡片的 Picture N 列表 → 放大层的参考图顺序：P1 → P2 → …（按编号，不按分组）。 */
export function refSequence(pictures: ViewerRef[]): ViewerRef[] {
  const number = (tag: string) => Number(/\d+/.exec(tag)?.[0] ?? Number.MAX_SAFE_INTEGER);
  return pictures.filter((picture) => picture.src).map((picture, i) => ({ picture, i })).sort((a, b) => number(a.picture.tag) - number(b.picture.tag) || a.i - b.i).map(({ picture }) => picture);
}

/** 参考图之间的前后（只在这一镜里，和视频的上一条 / 下一条分开）。 */
export function refNav(sequence: ViewerRef[], tag: string): { index: number; prev: string | null; next: string | null } {
  const index = sequence.findIndex((picture) => picture.tag === tag);
  if (index < 0) return { index, prev: null, next: null };
  return { index, prev: sequence[index - 1]?.tag ?? null, next: sequence[index + 1]?.tag ?? null };
}

/** 放大层上方 A/B/C：只列原片（去配乐版在下面「看去配乐版 / 切回原声」切换）；没给 letter 的旧调用照旧每条一个。 */
export function tagVersions<V extends ViewerVersion>(versions: V[]): V[] {
  return versions.some((item) => item.letter) ? versions.filter((item) => item.owner ?? !item.demixPasses) : versions;
}
/** 这个字母是不是正在看的那条（看去配乐版时原片字母亮着）。 */
export const sameTag = (item: ViewerVersion, shown: ViewerVersion) => item.letter && shown.letter ? item.letter === shown.letter : item.assetId === shown.assetId;
