import { getAsset } from './production-records.ts';
import { addRoleAsset, createRole, getRole, setPrimaryRoleAsset } from './role-records.ts';

export async function attachImageToRole(assetId: string, choice: { roleId?: string; newName?: string; primary: boolean }) {
  const asset = await getAsset(assetId);
  if (!asset || asset.kind !== 'image') throw new Error('图片素材已不存在，请重新选择图片');
  const role = choice.roleId ? await getRole(choice.roleId) : await createRole(choice.newName ?? '');
  if (!role) throw new Error('所选角色已不存在');
  const result = await addRoleAsset(role.roleId, assetId, 'image');
  return choice.primary ? await setPrimaryRoleAsset(role.roleId, assetId, 'image') : result.role;
}
