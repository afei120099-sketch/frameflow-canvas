/**
 * 镜头卡片 A/B/C：一镜可能有多个 H3 节点（「另存成新队列」重渲、「渲染这一镜」），每个节点各有自己的采用记录。
 * 以用户最近一次选择（adoptedAt 最大）为准；只有在那次选择之后又出了新提示词的新片、而所选是旧提示词时，才改显示新片。
 * 没有 adoptedAt 的旧采用记录按 0 算，同为 0 时较新的视频优先。
 */
export interface PickableVersion { adopted: boolean; adoptedAt?: number; stale: boolean; createdAt: number }

export function pickChosenVersion<T extends PickableVersion>(versions: T[]): T | null {
  if (!versions.length) return null;
  const byCreated = [...versions].sort((a, b) => a.createdAt - b.createdAt);
  const newestFresh = byCreated.filter((version) => !version.stale).at(-1);
  const latestPick = byCreated.filter((version) => version.adopted).sort((a, b) => (b.adoptedAt ?? 0) - (a.adoptedAt ?? 0) || b.createdAt - a.createdAt)[0];
  if (latestPick && (!latestPick.stale || !newestFresh || newestFresh.createdAt < (latestPick.adoptedAt ?? 0))) return latestPick;
  return newestFresh ?? latestPick ?? byCreated[byCreated.length - 1];
}

/**
 * 镜头卡片的字母（2026-11-12 用户：「去了配音不要变成 B，本来就是 A，B 是又渲了一条」）：
 * 只有真正出片的视频按时间排 A、B、C…；去配乐版（derivationType "music_removal"，×2 也一样）不占新字母，
 * 跟着它的原片（sourceVideoAssetId 一路往上找）叫「A · 去配乐」「A · 去配乐 ×2」，审片 / 对比里叫「A（去配乐版）」。
 * 原片不在这一镜的版本里（被删了等）的去配乐版才自己占一个字母。和画布节点「候选 A · 去配乐」同一个规则。
 */
export interface LetterSource { assetId: string; createdAt: number; derivationType?: string; sourceVideoAssetId?: string; musicRemovalPasses?: number }
export interface Lettered { /** 视频列 / 放大层显示：A、A · 去配乐、A · 去配乐 ×2 */ label: string; /** 原片字母：A/B/C 切换按这个分组 */ letter: string; /** 0 = 原声版 */ demixPasses: number; /** 这一条是不是 A/B/C 切换上的那个字母（原片，或找不到原片的去配乐版） */ owner: boolean; /** 审片、对比、导出：A、A（去配乐版）、A（去配乐 ×2 版） */ reviewLabel: string }

export const letterOf = (index: number) => { let value = index + 1, label = ""; while (value > 0) { value -= 1; label = String.fromCharCode(65 + (value % 26)) + label; value = Math.floor(value / 26); } return label; };

export function letterVersions<T extends LetterSource>(versions: readonly T[]): (T & Lettered)[] {
  const sorted = [...versions].sort((a, b) => a.createdAt - b.createdAt);
  const byId = new Map(sorted.map((item) => [item.assetId, item]));
  const isDemix = (item: LetterSource) => item.derivationType === "music_removal";
  const rootOf = (item: T): T | null => { let at: T | undefined = item; const seen = new Set<string>(); while (at && isDemix(at) && !seen.has(at.assetId)) { seen.add(at.assetId); at = at.sourceVideoAssetId ? byId.get(at.sourceVideoAssetId) : undefined; } return at && !isDemix(at) ? at : null; };
  const letters = new Map<string, string>();
  for (const item of sorted) if (!isDemix(item) || !rootOf(item)) letters.set(item.assetId, letterOf(letters.size));
  return sorted.map((item) => {
    const passes = isDemix(item) ? Math.max(1, item.musicRemovalPasses ?? 1) : 0;
    const root = isDemix(item) ? rootOf(item) : item;
    const owner = !root || root === item;
    const letter = letters.get((root ?? item).assetId) ?? letters.get(item.assetId) ?? "?";
    const kind = passes > 1 ? `去配乐 ×${passes}` : "去配乐";
    return { ...item, letter, demixPasses: passes, owner, label: passes ? `${letter} · ${kind}` : letter, reviewLabel: passes ? `${letter}（${kind}版）` : letter };
  });
}
