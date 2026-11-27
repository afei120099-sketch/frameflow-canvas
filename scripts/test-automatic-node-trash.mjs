import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {automaticallyRecycleNodeFiles} from '../lib/automatic-node-trash.ts';
import {mediaTrashBlockers,TRASH_REASON} from '../lib/media-trash-policy.ts';

globalThis.fetch=async()=>{throw Error('real network forbidden');};
const asset=id=>({assetId:id,storageReference:'media:'+id,kind:'video',filename:id+'.mp4',sourceRunId:'run:'+id});
function setup({protectedB=true,failB=false,lateReference=false,missingReceipt=false,group=false,failFinal=false,copy=false}={}){
  const rows=[asset('a'),asset('b')],recycled=new Set(),events=[];let reads=0,plans=0;
  const io={plan:async()=>{
    plans++;if(failFinal&&recycled.size===2)throw Error('final read failed');
    return {ids:group?['shape:group','shape:a','shape:b']:['shape:a','shape:b'],pageId:'page:test',fingerprint:'same',assetIdsByNode:{'shape:group':[],'shape:a':['a'],'shape:b':['b']},parentIdsByNode:group?{'shape:a':'shape:group','shape:b':'shape:group'}:{},
      assets:rows.filter(a=>!recycled.has(a.assetId)).map(a=>({asset:a,promptId:a.sourceRunId,reasons:a.assetId==='b'&&protectedB?['角色仍在引用']:lateReference&&reads?['其他节点仍在引用']:[]}))};},
    read:async a=>{events.push(['read',a.assetId]);reads++;return new Blob(['fixture']);},
    recycle:async(a,_blob,promptId)=>{events.push(['recycle',a.assetId,promptId]);if(failB&&a.assetId==='b')throw Error('helper unavailable');return {receiptId:missingReceipt?'':'receipt:'+a.assetId,recycled:true,mode:copy?'browser-copy':'generated-original'};},
    mark:async a=>{events.push(['mark',a.assetId]);recycled.add(a.assetId);},removeBytes:async source=>events.push(['bytes',source])};
  return {io,events,recycled};
}
let f=setup();let result=await automaticallyRecycleNodeFiles(f.io);
assert.deepEqual(result.removableIds,['shape:a','shape:b']);assert.deepEqual(result.recycled,['a']);assert.equal(result.kept.length,1);
assert.equal(f.events.some(e=>e[1]==='b'),false,'shared role media is not even loaded or posted');
assert.deepEqual(f.events.map(e=>e[0]),['read','recycle','mark','bytes']);
f=setup({protectedB:false,failB:true,group:true});result=await automaticallyRecycleNodeFiles(f.io);
assert.deepEqual(result.removableIds,['shape:group','shape:a','shape:b'],'user delete keeps every node removable even if one recycle fails');assert.equal(result.failures.length,1);
f=setup({lateReference:true});result=await automaticallyRecycleNodeFiles(f.io);assert.equal(result.recycled.length,0);assert.equal(f.events.some(e=>e[0]==='recycle'),false,'late added consumer preserved');assert.deepEqual(result.removableIds,['shape:a','shape:b']);
f=setup({missingReceipt:true});result=await automaticallyRecycleNodeFiles(f.io);assert.equal(result.recycled.length,0);assert.equal(f.events.some(e=>e[0]==='mark'||e[0]==='bytes'),false);assert.deepEqual(result.removableIds,['shape:a','shape:b']);
f=setup({protectedB:false,failFinal:true});result=await automaticallyRecycleNodeFiles(f.io);assert.deepEqual(result.removableIds,['shape:a','shape:b']);assert.equal(result.recycled.length,2);assert.match(result.failures[0].error,/已回收 2 份|最终核实失败/);
f=setup({copy:true});result=await automaticallyRecycleNodeFiles(f.io);assert.deepEqual(result.browserCopies,['a']);
const empty={pageId:'page:test',otherShapes:[],roles:[],runs:[],shots:[],otherAssets:[],metadata:[]};
const historicalAudit={key:'automatic-audit-v1:a',value:{version:1,assetId:'a',state:'pass'}};
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,metadata:[historicalAudit]}),[],'quality reports alone never retain media');
for(const metadata of [
  [{...historicalAudit,key:'automatic-audit-v1:other'}],
  [{key:'automatic-audit-v1:a',value:{version:2,assetId:'a'}}],
  [historicalAudit,{key:'sequence',value:{assetId:'a'}}],
])assert.ok(mediaTrashBlockers(asset('a'),{...empty,metadata}).length,'unknown records and real sequence consumers remain protected');
for(const patch of [{otherShapes:[{props:{assetId:'a'}}]},{roles:[{appearanceAssetIds:['a']}]},{roles:[{voiceAssetIds:['a']}]}])assert.ok(mediaTrashBlockers(asset('a'),{...empty,metadata:[historicalAudit],...patch}).length,'audit exclusion cannot hide live node or role references');
for(const patch of [{otherShapes:[{props:{src:'media:a'}}]},{roles:[{appearanceAssetIds:['a']}]},{roles:[{voiceAssetIds:['a']}]},{runs:[{status:'queued',inputAssetIds:['a']}]},{shots:[{adoptedAssetId:'a'}]},{metadata:[{items:['a']}]},{otherAssets:[{sourceAssetIds:['a']}]}])assert.ok(mediaTrashBlockers(asset('a'),{...empty,...patch}).length);
assert.ok(mediaTrashBlockers({...asset('a'),canvasPageIds:['page:other']},empty).length);

// Rule 5: only unfinished runs protect their inputs.
for(const status of ['completed','failed','cancelled'])assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[{status,inputAssetIds:['a'],referenceInputs:[{assetId:'a'}]}]}),[],status+' history run no longer protects');
for(const status of ['queued','running','some-future-state'])assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[{status,inputAssetIds:[],referenceManifest:{pictures:['media:a']}}]}),[TRASH_REASON.activeRun],status+' run still protects');

// Rule 6: queue rows protect only through unfinished entries (including stopped batches).
const queueRow=(entryPatch={},sessionPatch={},key='shot-queue-file-v2:s1')=>({key,value:{version:1,id:'s1',pageId:'page:test',origin:{x:0,y:0},
  queue:{title:'q',chapters:[{shots:[{prompt:'p'}]}]},entries:[{chapter:0,shot:0,nodeId:'shape:n',submissionState:'accepted',frameInputs:{first:{src:'media:a',sourceAssetId:'a'}},...entryPatch}],...sessionPatch}});
const doneRun={runId:'r1',status:'completed',ownerNodeId:'shape:n',createdAt:2,inputAssetIds:[]};
const failedRun={runId:'r0',status:'failed',ownerNodeId:'shape:n',createdAt:1,inputAssetIds:[]};
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[failedRun,doneRun],metadata:[queueRow()]}),[],'completed queue entry no longer protects');
for(const key of ['shot-queue-session-v1:page:test','shot-queue-session-archive-v1:s1'])assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[doneRun],metadata:[queueRow({},{},key)]}),[],key);
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,metadata:[queueRow({removedAt:1})]}),[],'removed entry no longer protects');
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,metadata:[queueRow({cancelledAt:1})]}),[],'cancelled entry no longer protects');
for(const [label,runs,row] of [
  ['entry not submitted yet',[],queueRow({nodeId:undefined,submissionState:'pending'})],
  ['failed entry in stopped batch (继续未完成 may resubmit)',[{...failedRun,createdAt:3},doneRun],queueRow({outcome:'failed',submissionState:'pending'},{stoppedAt:5,autoContinueFrames:false})],
  ['latest run still running',[doneRun,{...doneRun,runId:'r2',status:'running',createdAt:3}],queueRow()],
  ['completed but rerun requested',[doneRun],queueRow({rerun:{requestId:'x',previousRunId:'r1',requestedAt:3},submissionState:'pending'})],
  ['cancel only requested',[],queueRow({cancelRequestedAt:1})],
  ['reference in pending shot definition',[],queueRow({frameInputs:undefined},{queue:{title:'q',chapters:[{shots:[{images:['a']}]}]}})],
])assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs,metadata:[row]}),[TRASH_REASON.pendingQueue],label);
// Batch-level reference: free once every shot is done, protected while one is still open.
const twoShots=(second)=>({key:'shot-queue-file-v2:s2',value:{version:1,id:'s2',pageId:'page:test',style:{reference:'a'},queue:{title:'q',chapters:[{shots:[{},{}]}]},
  entries:[{chapter:0,shot:0,nodeId:'shape:n'},{chapter:0,shot:1,...second}]}});
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[doneRun],metadata:[twoShots({removedAt:1})]}),[]);
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[doneRun],metadata:[twoShots({submissionState:'pending'})]}),[TRASH_REASON.pendingQueue]);
// A queued shot without any entry is never assumed done.
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[doneRun],metadata:[{key:'shot-queue-file-v2:s3',value:{version:1,id:'s3',queue:{chapters:[{shots:[{},{ref:'media:a'}]}]},entries:[{chapter:0,shot:0,nodeId:'shape:n'}]}}]}),[TRASH_REASON.pendingQueue]);
// Unrecognised queue shapes fall back to the conservative scan.
for(const value of [{version:2,entries:[],ref:'a'},{version:1,entries:'bad',ref:'a'},{version:1,entries:[],queue:{chapters:'bad'},ref:'a'}])
  assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[doneRun],metadata:[{key:'shot-queue-file-v2:x',value}]}),[TRASH_REASON.metadata]);
// Rule 7: sequences / director data stay conservative.
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,metadata:[{key:'sequence-v1:x',value:{clips:[{assetId:'a'}]}}]}),[TRASH_REASON.metadata]);
// Rule 8: a derived asset that is deleted in the same operation no longer counts.
const derived={assetId:'b',storageReference:'media:b',sourceAssetIds:['a']};
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,otherAssets:[derived]}),[TRASH_REASON.otherAssets]);
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,otherAssets:[derived],deletingAssetIds:new Set(['a','b'])}),[]);
assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,otherAssets:[derived],deletingAssetIds:['a','c']}),[TRASH_REASON.otherAssets]);
// Rules 1-4 unchanged even when history runs/queues no longer protect.
for(const [patch,reason] of [[{otherShapes:[{props:{assetId:'a'}}]},TRASH_REASON.otherShapes],[{roles:[{appearanceAssetIds:['a']}]},TRASH_REASON.roles],[{shots:[{adoptedAssetId:'a'}]},TRASH_REASON.adopted]])
  assert.deepEqual(mediaTrashBlockers(asset('a'),{...empty,runs:[doneRun],metadata:[queueRow()],...patch}),[reason]);

// Actual safe-delete body: default branch auto-recycles; explicit keep-files remains opt-in.
const source=readFileSync('lib/safe-delete.ts','utf8');const ast=ts.createSourceFile('safe.ts',source,ts.ScriptTarget.Latest,true);
const pick=name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast).replace(/^export\s+/,'');
const fn=pick('deleteSummary')+'\n'+pick('safeDeleteNodes');
let autoCalls=0,deleted=[];
const shapesFor=ids=>ids.map(id=>({id,isLocked:false,parentId:'page:test'}));
const context=vm.createContext({cancelTasksBeforeNodeRemoval:async()=>()=>{},inspectNodeRemoval:async(_e,ids)=>({ok:true,ids:[...ids],fingerprint:'same',abandonedRunIds:[]}),updateRun:async()=>{},removalFingerprint:()=> 'same',removalShapes:(_e,ids)=>shapesFor(ids),nodeRemovalBusy:()=>false,
  recycleUnsharedNodeMedia:async()=>{autoCalls++;return automaticallyRecycleNodeFiles(setup().io);},deleteWithRestore:(_e,ids)=>{deleted=ids;return()=>true;},requestNodeDeletion:()=>{throw Error('default must not open dialog');}});
const safe=vm.runInContext(ts.transpileModule(fn+';safeDeleteNodes;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
// 1) 删除瞬间不回收（0 次），撤销窗口结束后才回收（1 次），且重复触发幂等
result=await safe({getCurrentPageId:()=>'page:test'},['shape:a','shape:b']);
assert.equal(result.ok,true);
assert.equal(autoCalls,0,'删除时立刻回收应为 0 次');
assert.deepEqual(deleted,['shape:a','shape:b']);
assert.equal(typeof result.commitRecycle,'function');
const finalSummary=await result.commitRecycle();
assert.equal(autoCalls,1,'撤销窗口结束后应回收 1 次');
assert.equal(finalSummary,'已删除 2 个节点，1 份原文件已进 Windows 回收站，1 份保留（1 份角色在用）。');
await result.commitRecycle();
assert.equal(autoCalls,1,'重复触发延迟回收必须幂等');


// 2) 撤销窗口内点了撤销：节点恢复且最终回收 0 次
autoCalls=0;deleted=[];
result=await safe({getCurrentPageId:()=>'page:test'},['shape:a','shape:b']);
assert.equal(result.ok,true);
assert.equal(autoCalls,0,'删除时应为 0 次');
assert.equal(result.undo(),true);
await result.commitRecycle();
assert.equal(autoCalls,0,'已撤销的删除不应触发回收');


// 3) 显式 canvas-only 不触发回收
const keepFiles=await safe({getCurrentPageId:()=>'page:test'},['shape:a'],'canvas-only');
assert.equal(keepFiles.commitRecycle,undefined);
assert.equal(autoCalls,0,'explicit node-only operation does not recycle');


// 4) 延迟回收失败不影响节点已删除（user delete is authoritative）
autoCalls=0;deleted=[];
context.recycleUnsharedNodeMedia=async()=>{autoCalls++;throw Error('原任务不是已确认成功，未清理');};
result=await safe({getCurrentPageId:()=>'page:test'},['shape:a','shape:b']);
assert.equal(result.ok,true);assert.deepEqual(deleted,['shape:a','shape:b']);assert.equal(autoCalls,0);assert.match(result.message,/已删除 2 个节点/);
const failedSummary=await result.commitRecycle();
assert.equal(autoCalls,1);assert.match(failedSummary,/原任务不是已确认成功/);
assert.match(readFileSync('components/canvas/safe-delete-action.ts','utf8'),/intent: DeleteIntent = 'cancel-and-recycle'/);
console.log('PASS automatic delete: user-delete wins, recycle best-effort, shared-file protection, late consumers, CPU mocks, no user files touched.');
