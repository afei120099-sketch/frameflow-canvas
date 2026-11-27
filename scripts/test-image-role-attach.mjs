import './fake-indexeddb.mjs';
import assert from 'node:assert/strict';
import { registerAsset } from '../lib/production-records.ts';
import { getRole, listRoles } from '../lib/role-records.ts';
import { attachImageToRole } from '../lib/image-role-attach.ts';

const first = await registerAsset({ kind: 'image', origin: 'imported', filename: '角色乙四视图.png', mimeType: 'image/png', storageReference: 'image:first', sourceRunId: null, fileSize: 10 });
const role = await attachImageToRole(first.assetId, { newName: '角色乙', primary: false });
assert.equal(role.primaryAppearanceAssetId, first.assetId, 'first image becomes primary appearance');
assert.deepEqual(role.appearanceAssetIds, [first.assetId]);

const second = await registerAsset({ kind: 'image', origin: 'imported', filename: '角色乙侧面.png', mimeType: 'image/png', storageReference: 'image:second', sourceRunId: null, fileSize: 10 });
await attachImageToRole(second.assetId, { roleId: role.roleId, primary: false });
assert.equal((await getRole(role.roleId)).primaryAppearanceAssetId, first.assetId, 'adding alone preserves primary');
await attachImageToRole(second.assetId, { roleId: role.roleId, primary: true });
const saved = await attachImageToRole(second.assetId, { roleId: role.roleId, primary: true });
assert.deepEqual(saved.appearanceAssetIds, [first.assetId, second.assetId], 'repeated adds cannot duplicate references');
assert.equal(saved.primaryAppearanceAssetId, second.assetId);

const audio = await registerAsset({ kind: 'audio', origin: 'imported', filename: 'voice.wav', mimeType: 'audio/wav', storageReference: 'audio:voice', sourceRunId: null, fileSize: 10 });
const count = (await listRoles()).length;
await assert.rejects(() => attachImageToRole(audio.assetId, { newName: 'must not create', primary: true }), /不存在|类型/);
await assert.rejects(() => attachImageToRole('missing', { newName: 'must not create', primary: true }), /不存在/);
assert.equal((await listRoles()).length, count, 'failed adds must not create roles');
console.log('PASS image-to-role: first image primary, add preserves primary, explicit primary replaces, dedupe, kind/missing guards');
