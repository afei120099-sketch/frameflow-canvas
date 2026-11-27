/**
 * 生产线「从画布匹配」: which canvas role / image / sound should fill each file name an episode
 * expects. Pure functions only (no IndexedDB, no DOM), so the node tests can run them.
 *
 * The episode JSON (often written by another AI) names files like `zhangsan_face.png` or `A15.png`
 * and gives each role a key + Chinese name (`{ key: "zhangsan", name: "张三" }`). The canvas library
 * has roles with a displayName ("张三") and image assets with their file names. The name is the
 * bridge for roles; file name stems (A15) are the bridge for scene / storyboard images.
 */

export type SlotKind = "face" | "appearance" | "voice" | "storyboard" | "audio";
export interface EpisodeRoleLike { key: string; name?: string; description?: string; face?: string | null; appearance?: string[]; voice?: string | null }
export interface EpisodeShotLike { shotId: string; title?: string; storyboard?: string | null; dialogue?: { roleId?: string; speaker?: string; voice?: string }[] }
export interface EpisodeLike { roles: EpisodeRoleLike[]; shots: EpisodeShotLike[] }

export interface Slot {
  name: string;
  kind: SlotKind;
  /** "image" slots take images, "audio" slots take sounds. */
  media: "image" | "audio";
  roleKey?: string;
  roleName?: string;
  roleDescription?: string;
  /** For appearance: index inside roles[].appearance (0 = main appearance). */
  index?: number;
  shotIds: string[];
  shotTitles: string[];
}

export interface CanvasRoleLike { roleId: string; displayName: string; description?: string; pageIds: string[]; faceAssetId: string | null; appearanceAssetIds: string[]; primaryAppearanceAssetId: string | null; voiceAssetId: string | null }
export interface CanvasAssetLike { assetId: string; filename: string; kind: "image" | "audio" | "video"; pageIds: string[]; createdAt: number }

export type RolePart = "face" | "appearance" | "voice" | `appearance:${number}`;
export type Source = { type: "role"; roleId: string; part: RolePart } | { type: "asset"; assetId: string };
export interface Suggestion { source: Source; score: number; reason: string; ambiguous: boolean }

const AUDIO_EXT = /\.(wav|mp3|flac|m4a|ogg)$/i;

/** Every file the episode expects, with what it is for. Order follows the episode's own media list. */
export function describeSlots(episode: EpisodeLike, names: readonly string[]): Slot[] {
  const slots = new Map<string, Slot>();
  const slot = (name: string, base: Omit<Slot, "name" | "shotIds" | "shotTitles" | "media">) => {
    if (!slots.has(name)) slots.set(name, { name, media: base.kind === "voice" || base.kind === "audio" || AUDIO_EXT.test(name) ? "audio" : "image", shotIds: [], shotTitles: [], ...base });
    return slots.get(name)!;
  };
  const roleInfo = (role: EpisodeRoleLike) => ({ roleKey: role.key, roleName: role.name, roleDescription: role.description });
  for (const role of episode.roles) {
    if (role.face) slot(role.face, { kind: "face", ...roleInfo(role) });
    (role.appearance ?? []).forEach((name, index) => slot(name, { kind: "appearance", index, ...roleInfo(role) }));
    if (role.voice) slot(role.voice, { kind: "voice", ...roleInfo(role) });
  }
  for (const shot of episode.shots) {
    if (shot.storyboard) { const s = slot(shot.storyboard, { kind: "storyboard" }); s.shotIds.push(shot.shotId); if (shot.title) s.shotTitles.push(shot.title); }
    for (const line of shot.dialogue ?? []) {
      if (!line.voice || line.voice === "none" || !line.voice.startsWith("audio:")) continue;
      const role = episode.roles.find((r) => r.key === line.roleId);
      const a = slot(line.voice.slice("audio:".length), role ? { kind: "audio", ...roleInfo(role) } : { kind: "audio", roleName: line.speaker });
      if (!a.shotIds.includes(shot.shotId)) a.shotIds.push(shot.shotId);
    }
  }
  return names.map((name) => slots.get(name) ?? { name, kind: AUDIO_EXT.test(name) ? "audio" : "storyboard", media: AUDIO_EXT.test(name) ? "audio" : "image", shotIds: [], shotTitles: [] });
}

const squash = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s_\-·.()（）\[\]【】]/g, "");
const stem = (filename: string) => filename.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{2,5}$/i, "");
const latin = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^a-z]/g, "");

/** How well a canvas role stands for an episode role (0 = not at all). */
export function roleScore(slot: Pick<Slot, "roleKey" | "roleName" | "name">, role: Pick<CanvasRoleLike, "roleId" | "displayName" | "description">): { score: number; reason: string } {
  // Canvas codes, as in the shot-queue JSON: role key (or file name prefix) is the canvas roleId.
  if (role.roleId && (slot.roleKey === role.roleId || stem(slot.name).startsWith(role.roleId))) return { score: 100, reason: "角色编码相同" };
  const display = squash(role.displayName || "");
  const name = squash(slot.roleName || "");
  if (name && display === name) return { score: 100, reason: `角色名「${role.displayName}」相同` };
  if (name.length >= 2 && display.length >= 2 && (display.includes(name) || name.includes(display))) return { score: 85, reason: `角色名「${role.displayName}」与「${slot.roleName}」相近` };
  const key = latin(slot.roleKey || stem(slot.name).replace(/_(face|full|appearance|look|body|voice|ref|\d+)$/i, ""));
  if (key.length >= 3) {
    const roleLatin = latin(role.displayName || "");
    if (roleLatin && roleLatin === key) return { score: 90, reason: `英文名 ${role.displayName} 对上 ${slot.roleKey ?? key}` };
    const words = (role.description || "").normalize("NFKC").toLowerCase().match(/[a-z][a-z\s]{2,}/g) ?? [];
    if (words.some((word) => latin(word) === key) || (roleLatin.length >= 3 && key.includes(roleLatin))) return { score: 70, reason: `描述里的英文名对上 ${slot.roleKey ?? key}` };
  }
  return { score: 0, reason: "" };
}

/** How well a canvas asset's file name stands for an expected file (0 = not at all). */
export function assetScore(slot: Pick<Slot, "name" | "shotIds">, asset: Pick<CanvasAssetLike, "filename"> & { assetId?: string }): { score: number; reason: string } {
  const want = stem(slot.name).toLowerCase(), have = stem(asset.filename || "").toLowerCase();
  if (!want || !have) return { score: 0, reason: "" };
  if (asset.assetId && want === asset.assetId.toLowerCase()) return { score: 100, reason: "素材编码相同" };
  if (asset.filename.toLowerCase() === slot.name.toLowerCase()) return { score: 100, reason: "文件名完全相同" };
  if (have === want) return { score: 96, reason: "文件名相同（扩展名不同）" };
  if (squash(have) === squash(want)) return { score: 92, reason: "文件名相同（大小写/符号不同）" };
  const token = (needle: string) => needle.length >= 2 && new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(have);
  if (token(want)) return { score: 78, reason: `文件名里有 ${stem(slot.name)}` };
  for (const shotId of slot.shotIds) if (token(shotId.toLowerCase())) return { score: 72, reason: `文件名里有镜头号 ${shotId}` };
  return { score: 0, reason: "" };
}

const PART_LABEL: Record<string, string> = { face: "脸部参考", appearance: "主外观", voice: "主声音" };
export const partLabel = (part: RolePart) => PART_LABEL[part] ?? `外观 ${Number(part.split(":")[1]) + 1}`;

/** Which part of a role fits a slot, if the role has it. */
export function rolePartFor(slot: Pick<Slot, "kind" | "index">, role: CanvasRoleLike): RolePart | null {
  if (slot.kind === "face") return role.faceAssetId ? "face" : role.primaryAppearanceAssetId || role.appearanceAssetIds.length ? "appearance" : null;
  if (slot.kind === "appearance") {
    const others = role.appearanceAssetIds.filter((id) => id !== role.primaryAppearanceAssetId && id !== role.faceAssetId);
    const index = slot.index ?? 0;
    if (index === 0) return role.primaryAppearanceAssetId || role.appearanceAssetIds.length ? "appearance" : null;
    return others[index - 1] ? `appearance:${role.appearanceAssetIds.indexOf(others[index - 1])}` : null;
  }
  if (slot.kind === "voice" || slot.kind === "audio") return role.voiceAssetId ? "voice" : null;
  return null;
}

/** Asset id a role part resolves to (null when the role does not have it). */
export function rolePartAsset(role: CanvasRoleLike, part: RolePart): string | null {
  if (part === "face") return role.faceAssetId;
  if (part === "voice") return role.voiceAssetId;
  if (part === "appearance") return role.primaryAppearanceAssetId ?? role.appearanceAssetIds[0] ?? null;
  return role.appearanceAssetIds[Number(part.split(":")[1])] ?? null;
}

/** Best automatic pick for one slot, or null. Exact file names win, then role names, then file-name tokens. */
export function suggest(slot: Slot, roles: readonly CanvasRoleLike[], assets: readonly CanvasAssetLike[]): Suggestion | null {
  const found: Suggestion[] = [];
  for (const asset of assets) {
    if (asset.kind !== slot.media) continue;
    const { score, reason } = assetScore(slot, asset);
    // A role image named after the role key but not after this exact file is weaker than the role itself.
    if (score) found.push({ source: { type: "asset", assetId: asset.assetId }, score: slot.roleKey && score < 92 ? score - 20 : score, reason, ambiguous: false });
  }
  if (slot.kind !== "storyboard") {
    for (const role of roles) {
      const part = rolePartFor(slot, role);
      if (!part) continue;
      const { score, reason } = roleScore(slot, role);
      if (score) found.push({ source: { type: "role", roleId: role.roleId, part }, score: score - (slot.kind === "face" && part !== "face" ? 3 : 0), reason: `${reason} · ${partLabel(part)}`, ambiguous: false });
    }
  }
  if (!found.length) return null;
  const created = new Map(assets.map((asset) => [asset.assetId, asset.createdAt]));
  found.sort((a, b) => b.score - a.score || (b.source.type === "asset" ? created.get(b.source.assetId) ?? 0 : 0) - (a.source.type === "asset" ? created.get(a.source.assetId) ?? 0 : 0));
  const best = found[0];
  return { ...best, ambiguous: found.length > 1 && found[1].score === best.score };
}

export const visibleOn = (pageId: string) => (row: { pageIds: string[] }) => !pageId || row.pageIds.includes(pageId) || !row.pageIds.length;

/** Score at which a match is filled without asking (name / file name / code agree). */
export const AUTO_FILL_SCORE = 85;
export interface PlannedSlot { slot: Slot; suggestion: Suggestion | null; auto: boolean }

/**
 * Suggestions for every slot, limited to one canvas page: the preferred page (the canvas the page was
 * opened from) when it matches anything, otherwise the page that matches the most slots confidently.
 * A canvas usually has the same role on several pages; mixing pages would make every role ambiguous.
 */
export function planFill(slots: readonly Slot[], roles: readonly CanvasRoleLike[], assets: readonly CanvasAssetLike[], pages: readonly string[], preferredPageId = ""): { pageId: string; plan: PlannedSlot[] } {
  const run = (pageId: string) => {
    const r = roles.filter(visibleOn(pageId)), a = assets.filter(visibleOn(pageId));
    return slots.map((slot) => { const suggestion = suggest(slot, r, a); return { slot, suggestion, auto: !!suggestion && suggestion.score >= AUTO_FILL_SCORE && !suggestion.ambiguous }; });
  };
  const count = (plan: PlannedSlot[]) => plan.filter((p) => p.auto).length;
  if (preferredPageId) { const plan = run(preferredPageId); if (count(plan)) return { pageId: preferredPageId, plan }; }
  let best = { pageId: "", plan: run("") };
  for (const pageId of pages) { const plan = run(pageId); if (count(plan) > count(best.plan)) best = { pageId, plan }; }
  return best;
}
