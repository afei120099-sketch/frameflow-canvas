import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { inspectNodeRemoval, removalFingerprint, removalShapes } from '../lib/node-removal-guard.ts';
import { probeRemovalTask, probeVoiceDesignRemoval } from '../lib/node-task-probe.ts';
import { holdNodeTask, hasNodeTask } from '../lib/node-task-activity.ts';
import { deleteWithRestore } from '../lib/canvas-delete-undo.ts';
globalThis.fetch = async () => { throw Error('Real network forbidden in E tests'); };
let cases = 0;
const shape = (id='shape:test',type='h3-node',props={}) => ({ id, typeName:'shape', type, parentId:'page:test', x:17, y:29, props:{w:560,h:644,...props}, meta:{} });
function editorFor(nodes=[shape()]) {
  const data=new Map(nodes.map(n=>[n.id,structuredClone(n)]));
  return { data, getCurrentPageId:()=> 'page:test', getShape:id=>data.get(id), store:{allRecords:()=>[...data.values()],get:id=>data.get(id),put:rows=>rows.forEach(r=>data.set(r.id,r)),remove:ids=>ids.forEach(id=>data.delete(id))}, markHistoryStoppingPoint(){}, deleteShapes(ids){for(const s of removalShapes(this,ids))data.delete(s.id);},run(action){action();} };
}
let runs=[], cover=null, state='failed', voiceState='failed', busy=false, probeCalls=[];
const deps={runs:async()=>structuredClone(runs),cover:async()=>structuredClone(cover),busy:()=>busy,probe:async(...args)=>{probeCalls.push(args);return state;},voice:async()=>voiceState};
const check=async(editor=editorFor(),key)=>{cases++;return inspectNodeRemoval(editor,['shape:test'],key,deps);};
const run=(patch={})=>({runId:'run:test',ownerNodeId:'shape:test',status:'running',comfyPromptId:'prompt:test',capabilityId:'h3_fl2va',startedAt:1,...patch});
assert.equal((await check()).ok,true);
busy=true;assert.equal((await check()).reason,'busy');busy=false;
runs=[run()];
for(const [s,reason] of [['queued','queued'],['running','busy'],['completed','has-result'],['uncertain','uncertain']]){state=s;assert.equal((await check()).reason,reason);}
state='failed';assert.equal((await check()).ok,true);
state='not_found';probeCalls=[];const first=await check();assert.equal(first.canForce,true);assert.equal(probeCalls.length,2);assert.equal((await check(editorFor(),first.confirmationKey)).ok,true);
const moved=editorFor();moved.data.get('shape:test').x++;assert.equal((await check(moved,first.confirmationKey)).canForce,true);
runs=[run({submission:'reserved'})];assert.equal((await check()).canForce,undefined);
runs=[run({status:'queued',startedAt:null,submission:'accepted'})];assert.equal((await check()).ok,true);
runs=[run({comfyPromptId:null})];assert.equal((await check()).ok,false);
runs=[];
for(const [type,kind,save]of [['flux-image-node','image','7'],['tts-node','audio','4'],['music-node','audio','9'],['audio-video-node','video','16']]){
  const e=editorFor([shape('shape:test',type,{pendingId:'pending:test'})]);state='completed';probeCalls=[];assert.equal((await check(e)).reason,'has-result');assert.deepEqual(probeCalls[0].slice(0,3),['pending:test',kind,save]);
  state='running';assert.equal((await check(e)).reason,'busy');state='failed';assert.equal((await check(e)).ok,true);state='not_found';assert.equal((await check(e)).canForce,true);
}
const tts=editorFor([shape('shape:test','tts-node',{pendingDesignId:'voice:test'})]);
for(const [s,reason]of [['queued','queued'],['running','busy'],['completed','has-result'],['uncertain','uncertain']]){voiceState=s;assert.equal((await check(tts)).reason,reason);}voiceState='failed';assert.equal((await check(tts)).ok,true);
const ce=editorFor([shape('shape:test','cover-node',{docId:'doc:test'})]);cover={ownerNodeId:'shape:test',work:{index:0}};assert.equal((await check(ce)).ok,false);
cover={ownerNodeId:'shape:test',work:{pendingId:'cover:prompt'}};state='completed';assert.equal((await check(ce)).reason,'has-result');state='failed';assert.equal((await check(ce)).ok,true);cover=null;
const group=shape('shape:test','group'),child={...shape('shape:child','tts-node',{pendingId:'pending:child'}),parentId:group.id};state='running';assert.equal((await check(editorFor([group,child]))).reason,'busy');state='failed';assert.equal((await check(editorFor([group,child]))).ids.length,2);
assert.equal((await check(editorFor([{...shape(),isLocked:true}]))).ok,false);
assert.equal((await check(editorFor([]))).ok,false);
const mutation=editorFor();const oldRuns=deps.runs;deps.runs=async()=>{mutation.data.get('shape:test').y++;return [];};assert.equal((await check(mutation)).ok,false);deps.runs=oldRuns;
const oldProbe=deps.probe;deps.probe=async()=>{throw Error('offline');};runs=[run()];assert.equal((await check()).canForce,undefined);deps.probe=oldProbe;runs=[];
const changingRuns=deps.runs;let readCount=0;deps.runs=async()=>++readCount===1?[]:[run()];assert.equal((await check()).ok,false);deps.runs=changingRuns;
const a=holdNodeTask('local'),b=holdNodeTask('local');assert.equal(hasNodeTask('local'),true);a();a();assert.equal(hasNodeTask('local'),true);b();assert.equal(hasNodeTask('local'),false);
const hold=holdNodeTask('shape:test');assert.equal((await inspectNodeRemoval(editorFor(),['shape:test'])).reason,'busy','real default guard recognizes the synchronous task registry before any DB read');hold();

// Real GET-only probe: result kind, failure, ambiguity, finish-between-reads, malformed/offline.
for(const[kind,save,key,name]of [['image','7','images','test.png'],['audio','4','audio','test.mp3'],['audio','9','audio','role-c.mp3'],['video','16','videos','test.mp4']]){
  const request=async(path,init)=>{assert.equal(init.method,undefined);assert.match(path,/\/history\//);return new Response(JSON.stringify({id:{status:{completed:true,status_str:'success'},outputs:{[save]:{[key]:[{filename:name}]}}}}));};
  assert.equal(await probeRemovalTask('id',kind,save,request),'completed');cases++;
}
const response=value=>new Response(JSON.stringify(value));
assert.equal(await probeRemovalTask('id','video','15',async()=>response({id:{status:{completed:true,status_str:'success'}}})),'uncertain');
assert.equal(await probeRemovalTask('id','video','15',async()=>response({id:{status:{status_str:'error'}}})),'failed');
let historyReads=0;assert.equal(await probeRemovalTask('id','image','7',async path=>response(path.includes('history')?(++historyReads===2?{id:{outputs:{7:{images:[{filename:'late.png'}]}}}}:{}):{queue_running:[],queue_pending:[]})),'completed');
await assert.rejects(()=>probeRemovalTask('id','audio','4',async path=>response(path.includes('history')?{}:{queue_running:null,queue_pending:[]})),/队列格式/);
await assert.rejects(()=>probeVoiceDesignRemoval('id',async()=>new Response('{}',{status:404})),/HTTP 404/);
assert.equal(await probeVoiceDesignRemoval('id',async()=>response({status:'running'})),'running');

// Actual safe-delete function, real delta undo, mocked metadata writes only.
const safeSource=readFileSync('lib/safe-delete.ts','utf8');const ast=ts.createSourceFile('safe.ts',safeSource,ts.ScriptTarget.Latest,true);const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='safeDeleteNodes').getText(ast).replace(/^export\s+/,'');
let writes=[],dialogs=[];const context=vm.createContext({cancelTasksBeforeNodeRemoval:async()=>()=>{},inspectNodeRemoval:(e,ids,key)=>inspectNodeRemoval(e,ids,key,deps),nodeRemovalBusy:()=>busy,removalShapes,removalFingerprint,deleteWithRestore,updateRun:async(id,patch)=>writes.push([id,patch]),requestNodeDeletion:ids=>dialogs.push(ids),Date});
const safe=vm.runInContext(ts.transpileModule(fn+';safeDeleteNodes;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
const e=editorFor([shape(),shape('shape:untouched','image-node')]),snapshot=structuredClone([...e.data]);
let result=await safe(e,['shape:test'],'canvas-only');assert.equal(result.ok,true);assert.equal(e.data.size,1);assert.equal(writes.length,0);assert.equal(result.undo(),true);assert.deepEqual([...e.data].sort(),snapshot.sort());
result=await safe(e,['shape:test'],'canvas-and-media');assert.equal(result.dialogOpened,true);assert.equal(e.data.size,2);assert.equal(dialogs.length,1);
runs=[run()];state='not_found';const token=await check(e);await safe(e,['shape:test'],'canvas-only',token.confirmationKey);assert.equal(writes.length,1);assert.match(writes[0][1].error,/用户确认移除，未核实/);
// Shared-file policy and user-delete authority stay in place.
assert.match(readFileSync('components/canvas/media-trash-dialog.tsx','utf8'),/自动回收无共享引用.*受保护文件保留/);
assert.match(readFileSync('lib/media-trash-policy.ts','utf8'),/Conservative, metadata-only reference checks/);
assert.match(readFileSync('lib/media-trash-client.ts','utf8'),/settleNodeTasksForRemoval/);
assert.match(readFileSync('lib/safe-delete.ts','utf8'),/User delete is authoritative/);
console.log('PASS E: '+cases+' guard/probe scenarios; all task types, descendants, state races, explicit force, actual deletion/undo, shared-file policy intact, user-delete wins; zero real network/GPU/files');
