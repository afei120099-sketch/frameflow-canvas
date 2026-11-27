import type { AssetRecord } from './production-records.ts';
import type { RoleRecord } from './role-records.ts';
import { isLibraryAsset } from './asset-library.ts';

export function roleImageIds(roles: RoleRecord[]) {
  return new Set(roles.flatMap(role => [...role.appearanceAssetIds, role.primaryAppearanceAssetId, role.faceReferenceAssetId, role.bodyReferenceAssetId].filter((id): id is string => !!id)));
}
export function selectAssetAiExport(assets: AssetRecord[], roles: RoleRecord[], visibleIds?: ReadonlySet<string>) {
  const roleImages = roleImageIds(roles);
  return assets.filter(asset => (isLibraryAsset(asset) && (!visibleIds || visibleIds.has(asset.assetId))) || (asset.kind === 'image' && roleImages.has(asset.assetId)));
}

export function buildAssetAiManifest(assets: AssetRecord[], roles: RoleRecord[], thumbnails: Record<string, string>, exportedAt: string, pageName = "当前画布", visibleIds?: ReadonlySet<string>) {
  const rows = assets.map(asset => {
    const roleNames = roles.filter(role => [...role.appearanceAssetIds, ...role.voiceAssetIds, role.primaryAppearanceAssetId, role.faceReferenceAssetId, role.bodyReferenceAssetId].includes(asset.assetId)).map(role => role.displayName);
    const tags = (asset as AssetRecord & { tags?: string[] }).tags;
    const scene = /场景|门口|室内|室外|办公室|房间|街道|庭院|建筑|背景|scene|interior|office/i.test(`${asset.filename} ${Array.isArray(tags) ? tags.join(' ') : ''}`);
    return { id: asset.assetId, filename: asset.filename, type: ({ image: '图片', video: '视频', audio: '声音' } as const)[asset.kind], dimensions: asset.width && asset.height ? `${asset.width}×${asset.height}` : '未知', source: asset.origin === 'imported' ? '导入' : asset.origin === 'generated' ? '生成' : '未知', libraryVisibility: visibleIds && !visibleIds.has(asset.assetId) ? '其他画布的素材' : isLibraryAsset(asset) ? '素材库显示' : '生成图，素材库里不显示', importedAt: asset.createdAt ? new Date(asset.createdAt).toISOString() : null, roleNames, boundRole: roleNames.length > 0, usage: roleNames.length ? '角色图' : scene ? '场景图' : '未分类', thumbnail: thumbnails[asset.assetId] ?? null };
  });
  const roleList = roles.map(role => ({ name: role.displayName, imageIds: rows.filter(row => row.type === '图片' && row.roleNames.includes(role.displayName) && [...role.appearanceAssetIds, role.primaryAppearanceAssetId, role.faceReferenceAssetId, role.bodyReferenceAssetId].includes(row.id)).map(row => row.id) }));
  return { pageName, exportedAt, count: rows.length, roles: roleList, groups: { 角色: rows.filter(row => row.usage === '角色图'), 场景: rows.filter(row => row.usage === '场景图'), 其他: rows.filter(row => row.usage === '未分类') } };
}
type Manifest = ReturnType<typeof buildAssetAiManifest>;
const cell = (value: unknown) => String(value ?? '—').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
export function assetAiMarkdown(data: Manifest) {
  const lines = [`# ${cell(data.pageName)}素材清单`, '', `导出时间：${data.exportedAt}；共 ${data.count} 条。`, '分类是根据角色绑定和文件名或标签猜测，请打开缩略图核对；无缩略图不代表素材不存在。', '', '## 角色及图片 ID', ...data.roles.map(role => `- ${cell(role.name)}：${role.imageIds.length ? role.imageIds.map(cell).join('、') : '缺图'}`)];
  for (const [group, rows] of Object.entries(data.groups)) {
    lines.push('', `## ${group}`, '', '| ID | 文件名 | 类型 | 尺寸 | 来源 | 素材库显示 | 导入时间（记录创建时间） | 绑定角色 | 用途猜测 | 缩略图 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) lines.push(`| ${[row.id,row.filename,row.type,row.dimensions,row.source,row.libraryVisibility,row.importedAt,row.roleNames.join('、') || '未绑定',row.usage,row.thumbnail || '无缩略图'].map(cell).join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}
export function assetAiInstructions(root: string, data: Manifest) {
  const folder = `${root.replace(/[\\/]+$/, '')}\\_素材库给AI`;
  return `请查看当前画布导出的素材清单：${folder}\\素材清单.md（机器可读版：${folder}\\素材清单.json）。缩略图在 ${folder}\\缩略图，按清单中素材 ID 找对应的 JPG。导出时间：${data.exportedAt}，共 ${data.count} 条。清单包含导入素材和角色绑定的生成图（素材库不显示生成图）。角色绑定归入角色，文件名或标签含场景等词归入场景，其余未分类；这是猜测，请核对。写队列时参考图 ID 从这里抄，别编；先打开缩略图确认人物、场景对不对，发现缺的、重复的、分错类的列出来告诉用户。`;
}
