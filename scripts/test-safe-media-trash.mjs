import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { mediaTrashBlockers, containsMediaReference } from '../lib/media-trash-policy.ts';
const source=readFileSync('lib/media-trash-client.ts','utf8');
const ast=ts.createSourceFile('trash.ts',source,ts.ScriptTarget.Latest,true);
const names=['outputReferences','postMediaRecycle','buildMediaTrashPlan','recyclePlannedMedia'];
const bodies=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast).replace(/^export\s+/,'')).join('\n');
let assets=[],roles=[],runs=[],shots=[],meta=[],busy=false,queueBusy=false,receipt=true,failSecond=false,posts=[],removed=[],events=[];
const editor={data:new Map(),getShape(id){return this.data.get(id);},store:{allRecords:()=>[...editor.data.values()]},getCurrentPageId:()=> 'page:test',markHistoryStoppingPoint(){},deleteShapes(ids){ids.forEach(id=>this.data.delete(id));}};
const context=vm.createContext({
  listAllAssets:async()=>assets,listAllRoles:async()=>roles,listRuns:async()=>runs,listShots:async()=>shots,listCleanupMetadata:async()=>meta,directorMetadata:async()=>[],
  isNodeClaimed:()=>false,mediaTrashBlockers,containsMediaReference,
  withProjectRestoreLock:async action=>action(),
  settleNodeTasksForRemoval:async()=>{events.push('guard');if(busy)throw Error('task busy');},
  getLocalImageBlob:async()=>new Blob(['FAKE'],{type:'image/png'}),getLocalAudioBlob:async()=>new Blob(['FAKE']),getLocalVideoBlob:async()=>new Blob(['FAKE']),
  markAssetRecycled:async(asset,r)=>{events.push('mark');asset.recycled=r;},removeRecycledMediaBytes:async src=>{events.push('remove');removed.push(src);},
  fetch:async(path,init)=>{
    if(path==='/comfyui/queue')return new Response(JSON.stringify({queue_running:queueBusy?[[0,'FAKE-active']]:[],queue_pending:[]}));
    const url=String(path);
    assert.ok(/127\.0\.0\.1:5189|\/api\/media-trash/.test(url),url);assert.equal(init.method,'POST');posts.push(url);events.push('receipt');return new Response(JSON.stringify({recycled:receipt&&!(failSecond&&posts.length===2),receiptId:'FAKE-receipt',mode:'test'}));
  },AbortSignal,URLSearchParams,Date,Blob,Set,Map,JSON,Error,
});
const compiled=ts.transpileModule(bodies+';({buildMediaTrashPlan,recyclePlannedMedia});',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const api=vm.runInContext(compiled,context);
function reset(){assets=[{assetId:'a',kind:'image',storageReference:'image:a',filename:'a.png',sourceRunId:null,canvasPageIds:['page:test']}];roles=[];runs=[];shots=[];meta=[];busy=false;queueBusy=false;receipt=true;failSecond=false;posts=[];removed=[];events=[];editor.data=new Map([['shape:a',{id:'shape:a',typeName:'shape',type:'image-node',parentId:'page:test',props:{assetId:'a',src:'image:a'},meta:{}}]]);}
for(const ref of ['other-page','other-shape','role','run-input','adopted','derived','metadata']){
  reset();
  if(ref==='other-page')assets[0].canvasPageIds.push('page:other');
  if(ref==='other-shape')editor.data.set('shape:other',{id:'shape:other',typeName:'shape',props:{src:'image:a'}});
  if(ref==='role')roles=[{appearanceAssetIds:['a']}];
  if(ref==='run-input')runs=[{status:'queued',inputAssetIds:['a']}];
  if(ref==='adopted')shots=[{adoptedAssetId:'a'}];
  if(ref==='derived')assets.push({assetId:'b',storageReference:'image:b',sourceAssetIds:['a']});
  if(ref==='metadata')meta=[{key:'sequence',value:{assetId:'a'}}];
  const plan=await api.buildMediaTrashPlan(editor,['shape:a']);assert.ok(plan.assets[0].reasons.length,ref);
  await assert.rejects(()=>api.recyclePlannedMedia(editor,plan,()=>{}),/受保护/);assert.equal(posts.length,0);assert.equal(editor.data.has('shape:a'),true);
}
reset();meta=[{key:'automatic-audit-v1:a',value:{version:1,assetId:'a',state:'pass'}}];
let auditPlan=await api.buildMediaTrashPlan(editor,['shape:a']);assert.equal(auditPlan.assets[0].reasons.length,0,'actual planner ignores historical quality report');
roles=[{appearanceAssetIds:['a']}];auditPlan=await api.buildMediaTrashPlan(editor,['shape:a']);assert.ok(auditPlan.assets[0].reasons.some(reason=>reason.includes('角色')),'role remains protected with historical audit');
// vm-realm arrays fail deepStrictEqual's prototype check; compare plain host copies.
const plain=value=>JSON.parse(JSON.stringify(value));
// Finished history: completed run input + completed queue entry no longer protect.
reset();runs=[{runId:'r:done',status:'completed',ownerNodeId:'shape:q',createdAt:1,inputAssetIds:['a']}];
meta=[{key:'shot-queue-file-v2:s',value:{version:1,id:'s',queue:{chapters:[{shots:[{}]}]},entries:[{chapter:0,shot:0,nodeId:'shape:q',frameInputs:{first:{src:'image:a',sourceAssetId:'a'}}}]}}];
assert.deepEqual(plain((await api.buildMediaTrashPlan(editor,['shape:a'])).assets[0].reasons),[],'finished run + finished queue entry are recyclable');
meta[0].value.stoppedAt=1;runs[0].status='failed';
assert.deepEqual(plain((await api.buildMediaTrashPlan(editor,['shape:a'])).assets[0].reasons),['未完成的队列仍在引用'],'unfinished entry of stopped batch still protects');
// Same-run siblings: all in this delete → recyclable; only part → protected.
const sibling=()=>{reset();assets=[{assetId:'a',kind:'image',storageReference:'image:a',filename:'a.png',sourceRunId:'r:x',canvasPageIds:['page:test']},{assetId:'b',kind:'image',storageReference:'image:b',filename:'b.png',sourceRunId:'r:x',canvasPageIds:['page:test']}];};
sibling();runs=[{runId:'r:x',status:'completed',ownerNodeId:'shape:a',createdAt:1,inputAssetIds:[]}];
let siblingPlan=await api.buildMediaTrashPlan(editor,['shape:a']);
assert.deepEqual(plain(siblingPlan.assets.map(row=>[row.asset.assetId,row.reasons.length])),[['a',0],['b',0]],'whole run deleted together');
sibling();runs=[{runId:'r:x',status:'completed',ownerNodeId:'shape:elsewhere',createdAt:1,inputAssetIds:[]}];
siblingPlan=await api.buildMediaTrashPlan(editor,['shape:a']);
assert.equal(siblingPlan.assets.length,1);assert.ok(siblingPlan.assets[0].reasons.some(reason=>reason.includes('同一生成任务')),'sibling outside delete keeps shared file');
// Both targeted, but the sibling is kept by a role → shared file stays (fixed point).
sibling();runs=[{runId:'r:x',status:'completed',ownerNodeId:'shape:a',createdAt:1,inputAssetIds:[]}];roles=[{appearanceAssetIds:['b']}];
siblingPlan=await api.buildMediaTrashPlan(editor,['shape:a']);
assert.deepEqual(plain(siblingPlan.assets.map(row=>row.reasons)),[['同一生成任务还有其他素材记录，磁盘原文件可能共用，保留'],['同一生成任务还有其他素材记录，磁盘原文件可能共用，保留','角色外观或声音仍在引用']]);
// Derived asset deleted in the same operation no longer protects its source.
reset();assets.push({assetId:'b',kind:'image',storageReference:'image:b',filename:'b.png',sourceRunId:null,sourceAssetIds:['a'],canvasPageIds:['page:test']});editor.data.set('shape:b',{id:'shape:b',typeName:'shape',type:'image-node',parentId:'page:test',props:{assetId:'b'},meta:{}});
assert.deepEqual(plain((await api.buildMediaTrashPlan(editor,['shape:a','shape:b'])).assets.map(row=>row.reasons)),[[],[]]);
reset();let plan=await api.buildMediaTrashPlan(editor,['shape:a']);busy=true;await assert.rejects(()=>api.recyclePlannedMedia(editor,plan,()=>{}),/busy/);assert.equal(posts.length,0);
reset();queueBusy=true;await assert.rejects(()=>api.buildMediaTrashPlan(editor,['shape:a']),/排队/);
reset();plan=await api.buildMediaTrashPlan(editor,['shape:a']);receipt=false;await assert.rejects(()=>api.recyclePlannedMedia(editor,plan,()=>{}),/凭据/);assert.equal(removed.length,0);assert.equal(editor.data.has('shape:a'),true);
reset();plan=await api.buildMediaTrashPlan(editor,['shape:a']);editor.data.get('shape:a').props.src='changed';await assert.rejects(()=>api.recyclePlannedMedia(editor,plan,()=>{}),/变化/);assert.equal(posts.length,0);
reset();plan=await api.buildMediaTrashPlan(editor,['shape:a']);let progress=0;assert.equal(await api.recyclePlannedMedia(editor,plan,n=>progress=n),1);assert.equal(progress,1);assert.deepEqual(removed,['image:a']);assert.equal(editor.data.has('shape:a'),false);assert.ok(events.indexOf('receipt')<events.indexOf('mark')&&events.indexOf('mark')<events.indexOf('remove'));
reset();assets.push({assetId:'b',kind:'image',storageReference:'image:b',filename:'b.png',sourceRunId:null});editor.data.set('shape:b',{id:'shape:b',typeName:'shape',type:'image-node',parentId:'page:test',props:{assetId:'b'},meta:{}});plan=await api.buildMediaTrashPlan(editor,['shape:a','shape:b']);failSecond=true;await assert.rejects(()=>api.recyclePlannedMedia(editor,plan,()=>{}),/1\/2/);assert.equal(editor.data.has('shape:a'),false);assert.equal(editor.data.has('shape:b'),true);assert.deepEqual(removed,['image:a']);
console.log('PASS E file safety: 7 reference blockers; busy/global queue/stale plan refusal; receipt-before-bytes; failed receipt retains node+bytes; partial success removes only successful test node; all in-memory, no user files/DB/network');
