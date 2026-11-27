import type { RoleRecord } from "./role-records.ts";

type RoleLike = Pick<RoleRecord, "roleId" | "displayName" | "appearanceAssetIds" | "primaryAppearanceAssetId">;
type QueueLike = { chapters: { shots: { roleIds: string[]; offscreenRoleIds?: string[] }[] }[] };

/**
 * Before an automatic queue submits: every on-screen role needs a 主外观.
 * Works for any project — nothing is hard-coded. A role that has no 主外观 gets one only when
 * the choice is unambiguous (exactly one 外观图). With several, the user picks; we never guess.
 */
export function planQueuePrimaries(queue: QueueLike, roles: readonly RoleLike[]): { set: { roleId: string; assetId: string; name: string }[]; error: string | null } {
  const needed = new Set(queue.chapters.flatMap((chapter) => chapter.shots.flatMap((shot) => shot.roleIds.filter((id) => !shot.offscreenRoleIds?.includes(id)))));
  const missing = [...needed].filter((id) => !roles.some((role) => role.roleId === id));
  if (missing.length) return { set: [], error: `角色不存在：${missing[0]}` };
  const set: { roleId: string; assetId: string; name: string }[] = [];
  for (const role of roles) {
    if (!needed.has(role.roleId) || role.primaryAppearanceAssetId) continue;
    const images = [...new Set(role.appearanceAssetIds)];
    if (!images.length) return { set: [], error: `角色「${role.displayName}」没有外观图，无法提交` };
    if (images.length > 1) return { set: [], error: `角色「${role.displayName}」有 ${images.length} 张外观图，还没选主外观。请在「角色」里点「设为主外观」选一张，再入队（不替你猜）` };
    set.push({ roleId: role.roleId, assetId: images[0], name: role.displayName });
  }
  return { set, error: null };
}
