import assert from 'node:assert/strict';
import './fake-indexeddb.mjs';
import { configureCanvasLibraryScope, collectLibraryReferences } from '../lib/canvas-library-scope.ts';
import { installCanvasLibraryScope, planLibraryOwnership, planLegacyLibraryRepair } from '../lib/canvas-library-migration.ts';
import { createRole, listRoles, listAllRoles, getRole, updateRoleDetails, deleteRole, addRoleAsset, setPrimaryRoleAsset, assignRoleToCanvases } from '../lib/role-records.ts';
import { registerAsset, listAssets, listAllAssets, getAsset, createRun, getMeta, renameAsset, putMeta, assignAssetToCanvases } from '../lib/production-records.ts';
import { collectProject, exportProject, readBackup, restoreProject } from '../lib/project-backup.ts';

const image = name => registerAsset({kind:'image',origin:'imported',filename:name,mimeType:'image/png',storageReference:'image:'+name,sourceRunId:null});
// Legacy catalogues: first page fallback, nested nodes, references and independent role edits.
const shared = await createRole('旧主角');
const orphanRole = await createRole('未绑定角色');
const a = await image('A.png'), b = await image('B.png'), orphan = await image('旧素材.png');
await addRoleAsset(shared.roleId,a.assetId,'image');
const records = [
  {id:'shape:group',parentId:'page:A',props:{}},
  {id:'shape:A',parentId:'shape:group',props:{roleIds:[shared.roleId],src:a.storageReference}},
  {id:'shape:B',parentId:'page:B',props:{voiceRoleId:shared.roleId,referenceImages:[{assetId:b.assetId}]}}
];
const pages = [{id:'page:A'},{id:'page:B'},{id:'page:C'}];
const plan = planLibraryOwnership(pages,records,await listAllAssets(),await listAllRoles());
assert.deepEqual(plan.rolePages.get(shared.roleId),['page:A','page:B']);
assert.deepEqual(plan.rolePages.get(orphanRole.roleId),['page:A']);
assert.deepEqual(plan.assetPages.get(b.assetId),['page:B']);
// A blank runId/shotId is not a history join key. Previously it pulled foreign runs into every page.
assert.equal(collectLibraryReferences({runId:'',shotId:''}).size,0);
const legacyAssets=await listAllAssets(), legacyRoles=await listAllRoles();
const blankRecords=[...records,{id:'shape:C',parentId:'page:C',props:{runId:'',shotId:'',pendingId:''}}];
const foreignHistories=[{ownerNodeId:'shape:deleted',outputAssetIds:[orphan.assetId]}];
const strictPlan=planLibraryOwnership(pages,blankRecords,legacyAssets,legacyRoles,foreignHistories);
assert.deepEqual(strictPlan.assetPages.get(orphan.assetId),['page:A']);
const pollutedAssets=legacyAssets.map(row=>({...row,canvasPageIds:row.assetId===orphan.assetId?pages.map(p=>p.id):plan.assetPages.get(row.assetId)}));
const pollutedRoles=legacyRoles.map(row=>({...row,canvasPageIds:row.roleId===orphanRole.roleId?pages.map(p=>p.id):plan.rolePages.get(row.roleId)}));
const repair=planLegacyLibraryRepair(pages,blankRecords,pollutedAssets,pollutedRoles,foreignHistories,{}, {assets:legacyAssets,roles:legacyRoles});
assert.deepEqual(repair.roleChanges,[{id:orphanRole.roleId,pages:['page:A']}]);
assert.deepEqual(repair.assetChanges,[{id:orphan.assetId,pages:['page:A']}]);
assert.equal(repair.roleChanges.some(r=>r.id===shared.roleId),false,'genuine shared role stays on both pages');
assert.equal(planLegacyLibraryRepair(pages,blankRecords,pollutedAssets,pollutedRoles,foreignHistories,{}, {assets:pollutedAssets,roles:pollutedRoles}).assetChanges.length,0,'explicit scoped imports are not legacy repair targets');
let current = 'page:B';
const refs = () => collectLibraryReferences(records.filter(r=>r.id==='shape:B').map(r=>r.props));
const editor = {getPages:()=>pages,store:{allRecords:()=>records},getCurrentPageId:()=>current,getCurrentPageShapes:()=>current==='page:B'?[{props:records[2].props}]:current==='page:A'?[{props:records[1].props}]:[]};
await putMeta('canvas-library-isolation-v1-original-catalogues',{assets:legacyAssets,roles:legacyRoles});
await assignRoleToCanvases(orphanRole.roleId,pages.map(p=>p.id),true);
await assignAssetToCanvases(orphan.assetId,pages.map(p=>p.id),true);
await installCanvasLibraryScope(editor);
assert.ok(await getMeta('canvas-library-isolation-v1-original-catalogues'));
const repaired=await getMeta('canvas-library-isolation-v2-empty-history-repair');
assert.equal(repaired.completed,true);
assert.equal(repaired.roleChanges.length,1);
assert.equal(repaired.assetChanges.length,1);
assert.equal((await listAllRoles()).length,legacyRoles.length);
assert.equal((await listAllAssets()).length,legacyAssets.length);
assert.equal((await getMeta('canvas-library-isolation-v2-empty-history-repair-backup')).roles.find(r=>r.roleId===orphanRole.roleId).canvasPageIds.length,3,'original contaminated ownership retained in backup');
assert.deepEqual((await listRoles()).map(r=>r.roleId),[shared.roleId]);
assert.equal((await listAssets()).some(r=>r.assetId===orphan.assetId),false);
await updateRoleDetails(shared.roleId,{displayName:'B专属名字'});
current='page:A';
assert.equal((await getRole(shared.roleId)).displayName,'旧主角');
assert.equal((await listRoles()).some(r=>r.roleId===orphanRole.roleId),true);
assert.equal((await listAssets()).some(r=>r.assetId===orphan.assetId),false, 'unreferenced legacy asset is not assigned to the first page');
await updateRoleDetails(shared.roleId,{description:'只属于A'});
current='page:B';
assert.equal((await getRole(shared.roleId)).displayName,'B专属名字');
assert.equal((await getRole(shared.roleId)).description,'');
await image('A.png'); // explicitly import the shared asset on B before editing it there
await renameAsset(a.assetId,'B自己的素材名.png');
current='page:A';assert.equal((await getAsset(a.assetId)).filename,'A.png');
current='page:B';assert.equal((await listAssets()).find(r=>r.assetId===a.assetId).filename,'B自己的素材名.png');
await deleteRole(shared.roleId);
assert.equal(await getRole(shared.roleId),null,'deleted role stays deleted even while old nodes retain its ID');
current='page:A';assert.ok(await getRole(shared.roleId),'other page card is not deleted');
current='page:C';
assert.equal((await listRoles()).length,0);
assert.equal((await listAssets()).length,0);
assert.equal(await getRole(orphanRole.roleId),null);
await assert.rejects(updateRoleDetails(orphanRole.roleId,{displayName:'不能跨页修改'}),/不属于/);
const newRole = await createRole('C主角');
const c = await image('C.png');await addRoleAsset(newRole.roleId,c.assetId,'image');await setPrimaryRoleAsset(newRole.roleId,c.assetId,'image');
assert.equal((await getRole(newRole.roleId)).primaryAppearanceAssetId,c.assetId);
current='page:A';assert.equal(await getRole(newRole.roleId),null);assert.equal((await listAssets()).some(r=>r.assetId===c.assetId),false);
// Async insert captures its origin before awaiting, not the page active when it completes.
let release; const gate=new Promise(resolve=>{release=resolve;});
configureCanvasLibraryScope(()=>({pageId:current,references:new Set()}),gate);
const pending=image('异步A.png');current='page:B';release();const pendingAsset=await pending;
assert.deepEqual(pendingAsset.canvasPageIds,['page:A']);
configureCanvasLibraryScope(()=>({pageId:current,references:refs()}));
const run=await createRun({capabilityId:'h3_fl2va',inputAssetIds:[],rawPrompt:'p',finalPrompt:'p',seed:1,parameters:{},workflowIdentity:{},referenceInputs:[]});
current='page:C';
const output=await registerAsset({kind:'video',origin:'generated',filename:'B-output.mp4',mimeType:'video/mp4',storageReference:'media:B-output',sourceRunId:run.runId});
assert.deepEqual(output.canvasPageIds,['page:B']);
assert.equal((await listAssets()).some(row=>row.assetId===output.assetId),false);
// Backups retain all pages and per-page cards; raw media and old IDs are not removed.
const project=await collectProject();
assert.equal(project.records.roles.length,(await listAllRoles()).length);
assert.equal(project.records.assets.length,(await listAllAssets()).length);
assert.ok(project.records.roles.find(r=>r.roleId===shared.roleId).canvasVersions['page:B']);
await installCanvasLibraryScope(editor); // reload/idempotence
current='page:B';assert.equal(await getRole(shared.roleId),null);
current='page:A';assert.equal((await getRole(shared.roleId)).description,'只属于A');
const files=new Map();
await exportProject(null,{writeText:async(p,text)=>{files.set(p,new Blob([text]));},writeBlob:async(p,blob)=>{files.set(p,blob);}},{appVersion:'isolation-test',persistenceKey:'isolated'});
const parsed=await readBackup({has:p=>files.has(p),size:p=>files.get(p)?.size??null,readText:p=>files.get(p).text(),readBlob:async p=>files.get(p)});
assert.equal((await restoreProject(parsed,{current:()=>null,load:()=>{}})).ok,true);
current='page:A';assert.equal((await getRole(shared.roleId)).description,'只属于A');
current='page:B';assert.equal(await getRole(shared.roleId),null);
current='page:C';assert.equal((await getRole(newRole.roleId)).primaryAppearanceAssetId,c.assetId);
configureCanvasLibraryScope();
console.log('PASS: page-scoped assets and roles; legacy migration/grouped refs; independent edits and deletion; empty new page; async origin; background Run outputs; idempotence; full backup/export/restore preservation. No real browser data or GPU touched.');
