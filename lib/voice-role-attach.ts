import { getAsset } from './production-records.ts';
import { addRoleAsset, createRole, getRole, setPrimaryRoleAsset } from './role-records.ts';

export async function attachVoiceToRole(assetId:string,choice:{roleId?:string;newName?:string;primary:boolean}) {
  const asset=await getAsset(assetId);
  if(!asset||asset.kind!=='audio')throw new Error('配音素材已不存在，请重新选择结果');
  const role=choice.roleId?await getRole(choice.roleId):await createRole(choice.newName ?? '');
  if(!role)throw new Error('所选角色已不存在');
  const result=await addRoleAsset(role.roleId,assetId,'audio');
  return choice.primary?await setPrimaryRoleAsset(role.roleId,assetId,'audio'):result.role;
}
