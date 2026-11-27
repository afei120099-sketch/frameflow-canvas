import { loadManifestRoles, type BuildManifestInput } from './reference-manifest.ts';
import { dialogueAudioIds, type H3DialogueLine } from './h3-dialogue.ts';

type Selection = {roleIds: string[]; voiceRoleId?: string; voiceRoleIds?: string[]; offscreenRoleIds?: string[]; dialogue?: H3DialogueLine[]};
type RoleData = Pick<BuildManifestInput,'roles'|'roleAssets'|'missingRoleIds'>;
const keyOf = (input: Selection) => JSON.stringify([input.roleIds,input.voiceRoleId ?? '',input.offscreenRoleIds ?? [],[...new Set((input.dialogue ?? []).map(line=>line.roleId))], ...dialogueAudioIds(input.dialogue).map(id=>['dialogue_audio',id]), ...(input.voiceRoleIds?.length ? [['voice_roles',...input.voiceRoleIds]] : [])]);
export function freezeH3Roles(selection: Selection, data: RoleData) { return JSON.stringify({version:1,key:keyOf(selection),data}); }
/** A re-render keeps the same role identity/assets even if the shared role library changes. */
export async function readH3Roles(selection: Selection, saved: string | undefined, readRole: Parameters<typeof loadManifestRoles>[1], readAsset: Parameters<typeof loadManifestRoles>[2]): Promise<RoleData> {
  if (saved) {
    let value: {version:number;key:string;data:RoleData};
    try { value=JSON.parse(saved); } catch { throw new Error('上次角色绑定快照损坏；请在角色／更多中重新读取角色库'); }
    if (value.version !== 1 || !value.data?.roles || !value.data.roleAssets) throw new Error('角色绑定快照格式不支持；请重新读取角色库');
    if (value.key === keyOf(selection)) {
      // Retain the chosen IDs/metadata. Recheck availability, but let the manifest
      // reject only assets actually used (an explicit appearance can replace the primary).
      const data = structuredClone(value.data);
      for (const [id, prior] of Object.entries(data.roleAssets)) {
        const current = await readAsset(id);
        if (!current || !prior || current.kind !== prior.kind || current.storageReference !== prior.storageReference) data.roleAssets[id] = null;
      }
      return data;
    }
  }
  const data=await loadManifestRoles(selection.roleIds,readRole,readAsset);
  for (const id of dialogueAudioIds(selection.dialogue)) data.roleAssets[id]=await readAsset(id);
  return data;
}
