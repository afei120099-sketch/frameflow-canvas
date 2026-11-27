// 「停止后续排队」2026-11-12 修复：卡在任何等待点，点停止几秒内循环退出、界面解锁、提示写明停了几镜；
// 实在停不掉给「强制解锁」；「状态待确认」不再把卡片锁成「排队中 1/28」。CPU 模拟，不碰 ComfyUI / 浏览器。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {bounded,boundedLock} from '../lib/operation-scope.ts';
import {entryDue,mergeSessionDelta,adoptSessionSnapshot} from '../lib/queue-entry-state.ts';
import {prepareInboxShotRetry,cancelInboxShot} from '../lib/inbox-shot-actions.ts';
import {SubmissionUncertainError} from '../lib/ai-adapter.ts';
import {classifyQueueSubmissionError,QueuePersistenceError} from '../lib/queue-submission-policy.ts';
import {latestQueueRun,maySubmitQueueEntry,queueEntryUncertain,newQueueSession,queueNodePosition,queueRowKey,queueSessionKey,healPowerLossQueueEntries} from '../lib/shot-queue-session.ts';
import {planShotReferences,shotQueueH3Props,parseShotQueue} from '../lib/shot-queue.ts';
import {queueFramePlan,queueFrameDescription,assertQueueFrameRemoval,QueueFrameWaitingError,resolveQueueFrameInputs,frameEntriesToResume,hasQueueFrameSources} from '../lib/shot-queue-frames.ts';
import {planInboxResume} from '../lib/inbox-resume-plan.ts';
import {missingPrimaryVoice} from '../lib/queue-voice-validation.ts';
import {PreparationUnavailableError} from '../lib/comfyui/preparation-connection.ts';
import {legacyPreparationNotSentCandidate,provenPreparationNotSent} from '../lib/preparation-not-sent.ts';
import {createQueueFrameRunObserver} from '../lib/queue-frame-run-observer.ts';
import {shotFileDisposition,prepareFileRerun} from '../lib/inbox-file-policy.ts';
import {releaseSettledSourceContinuations,rerunProbeAllows} from '../lib/comfy-lost-verdict.ts';
import {findReusableShots,planBatchStart} from '../lib/shot-queue-batch-plan.ts';
import {waitForInboxRootControl,assertInboxSessionActive,applyInboxRootControl,readInboxRootSnapshot} from '../lib/inbox-root-control.ts';
import {queueLockState,abortable,waitUntil,describeStop,STOP_EXIT_MS,FORCE_UNLOCK_NOTE} from '../lib/queue-stop.ts';

const read=path=>readFileSync(path,'utf8').replaceAll('\r\n','\n');

// ── 1. 卡片锁：状态待确认不锁；停过的批次不等 ComfyUI 里剩下的；循环在跑才锁 ──
assert.equal(queueLockState({a:{status:'completed'},b:{status:'unconfirmed'},c:{status:'unconfirmed'}},false,true).locked,false,'现场：1 镜出片 + 6 镜状态待确认、循环已退出 → 不再「排队中 1/28」锁死');
assert.equal(queueLockState({b:{status:'unconfirmed'}},false,false).locked,false,'状态待确认是落盘记录，不是 ComfyUI 里的任务，不锁');
assert.equal(queueLockState({a:{status:'unconfirmed'}},false,false).unconfirmed,1);
assert.equal(queueLockState({a:{status:'queued'}},false,false).locked,true,'没停的批次 ComfyUI 里真有排队：照旧锁');
assert.equal(queueLockState({a:{status:'running'}},false,true).locked,false,'停过的批次：正在跑的那一镜照常跑完，卡片不锁');
assert.equal(queueLockState({},true,true).locked,true,'提交循环在跑：锁');

// ── 2. abortable / waitUntil ──
{const c=new AbortController();const never=new Promise(()=>{});const p=abortable(never,c.signal);c.abort(new DOMException('stop','AbortError'));await assert.rejects(p,{name:'AbortError'});}
{const c=new AbortController();assert.equal(await abortable(Promise.resolve(7),c.signal),7);}
{const c=new AbortController();const late=new Promise((_,reject)=>setTimeout(()=>reject(Error('late')),20));const p=abortable(late,c.signal);c.abort();await assert.rejects(p);await new Promise(r=>setTimeout(r,40));/* late rejection swallowed, no unhandled rejection */}
assert.equal(await waitUntil(()=>false,120,20),false);
let flip=false;setTimeout(()=>{flip=true;},30);assert.equal(await waitUntil(()=>flip,1000,10),true);

// ── 3. 停完的那句话 ──
{const text=describeStop({states:['completed',...Array(21).fill('failed'),...Array(6).fill('unconfirmed')],cancelledNow:0,exited:true,wasRunning:false});
  assert.match(text,/本来就没在跑/);assert.match(text,/本批 28 镜/);assert.match(text,/已出片 1/);assert.match(text,/状态待确认 6（不会自动重提/);assert.match(text,/ComfyUI 里已经没有本批的任务/);assert.match(text,/卡片已解锁/);}
{const text=describeStop({states:['running','queued','pending','removed'],cancelledNow:2,exited:false,wasRunning:true,notes:['x']});
  assert.match(text,/本批 3 镜/);assert.match(text,/正在 ComfyUI 生成 1（保留，会跑完）/);assert.match(text,/这次从 ComfyUI 排队里撤下 2/);assert.match(text,/ComfyUI 里还有本批 2 镜，不会被取消/);assert.match(text,/强制解锁/);}
assert.match(describeStop({states:[],cancelledNow:0,exited:true,wasRunning:true}),/还没建节点，没有任何镜头提交到 ComfyUI/);

// ── 4. 真跑提交循环（vm 里加载 use-shot-queue-execution.ts，全部依赖是 CPU 假件） ──
const raw=()=>({version:'shot-queue-v1',title:'stop test',defaults:{seed:123,megapixels:0.45},chapters:[{title:'first',shots:Array.from({length:3},(_,i)=>({title:'S-'+i,prompt:'CPU mock test',seconds:6,aspect:'16:9',roleIds:[],sceneAssetIds:[],autoVoiceDisabled:true}))}]});
const hookSource=read('components/use-shot-queue-execution.ts').replace(/^import .*;\n/gm,'').replace('export function useShotQueueExecution','function useShotQueueExecution');
assert.doesNotMatch(hookSource,/^import /m,'all imports are single-line and stripped');
const code=ts.transpileModule(hookSource+'\nglobalThis.useQueue=useShotQueueExecution;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const OPEN={autoEnqueue:true,autoChain:true,submit:true,stop:false,effective:{autoEnqueue:true,autoChain:true,submit:true},error:null,readAt:'',version:1};
const STOPPED={autoEnqueue:true,autoChain:true,submit:true,stop:true,effective:{autoEnqueue:false,autoChain:false,submit:false},error:null,readAt:'',version:1};

function harness(hooks={}){
  const queue=parseShotQueue(JSON.stringify(raw()));
  const data={saved:null,runs:[],submitted:[],messages:[],focus:[],cancelCalls:0,listRunsCalls:0};
  const editor={shapes:new Map(),getCurrentPageId:()=>'page:stop-test',getCurrentPageShapes(){return [...this.shapes.values()];},getShape(id){return this.shapes.get(id);},getShapePageBounds:()=>({x:0,y:0,w:700,h:800}),updateShape(patch){const old=this.shapes.get(patch.id);this.shapes.set(patch.id,{...old,...patch,props:{...old?.props,...patch.props},meta:{...old?.meta,...patch.meta}});}};
  let call=0;
  const context=vm.createContext({Error,TypeError,DOMException,AbortController,AbortSignal,crypto,console,Map,Set,Promise,Date,JSON,Uint32Array,structuredClone,setTimeout,clearTimeout,
    QueuePersistenceError,SubmissionUncertainError,classifyQueueSubmissionError,bounded,boundedLock,entryDue,adoptSessionSnapshot,
    abortable,waitUntil,describeStop,STOP_EXIT_MS,FORCE_UNLOCK_NOTE,
    checkQueueGate:async()=>({ok:true}),
    saveSessionDelta:async(value,before,options)=>{const merged=data.saved?.id===value.id&&before?mergeSessionDelta(data.saved,value,before,{explicitResume:options?.explicitResume}):structuredClone(value);data.saved=structuredClone(merged);return merged;},
    rememberFileSession:async()=>{},readInboxRootSnapshot,shotFileDisposition,prepareFileRerun,
    assertInboxSessionActive,subscribeInboxRootControl:()=>()=>{},
    waitForInboxRootControl:hooks.rootGate?async(kind,guard)=>{guard?.();data.inRootGate=true;await hooks.rootGate(kind);guard?.();}:waitForInboxRootControl,
    prepareInboxShotRetry,cancelInboxShot,planInboxResume,missingPrimaryVoice,PreparationUnavailableError,legacyPreparationNotSentCandidate,provenPreparationNotSent,
    beginInboxRequest:()=>{},matchingInboxRequest:()=>undefined,reportInboxRequest:()=>{},registerInboxRecovery:()=>()=>{},registerQueueRemovalCancel:()=>()=>{},
    diagnoseCanvasRecords:async()=>({matches:true,differences:[]}),
    useValue:(_name,getter)=>getter(),useState:initial=>[initial===''?'page:stop-test':initial,value=>{if(typeof value==='function')data.rows=value(data.rows??{});}],useRef:value=>({current:value}),useEffect(){},
    getMeta:async()=>structuredClone(data.saved),putMeta:async(key,value)=>{if(!key.startsWith('shot-queue-session-archive-v1:'))data.saved=structuredClone(value);},
    listRoles:async()=>[],getAsset:async()=>null,fetchZhengbenVersion:async()=>undefined,
    listRuns:async()=>{data.listRunsCalls++;if(hooks.hangListRuns?.(data)){data.hung=true;await new Promise(resolve=>{data.releaseHang=resolve;});}return structuredClone(data.runs);},
    waitForCanvasSave:async()=>{},withLock:async(_key,fn)=>fn(),saveNodeForRun:()=>'148',updateRun:async(id,patch)=>{Object.assign(data.runs.find(r=>r.runId===id),patch);},
    comfyUIH3Adapter:{cancelPendingJobs:async()=>{data.cancelCalls++;return[];},probeJob:async()=>({state:'not_found'}),queueJobs:async()=>[]},
    readH3Automation:id=>hooks.notReady?{}:{taskMode:'t2va',enqueue:async()=>{const n=call++;data.submitted.push(id);data.runs.push({runId:'run-'+n,comfyPromptId:'fake-'+n,ownerNodeId:id,status:'queued',submission:'accepted',createdAt:Date.now()+n});return{runId:'run-'+n,promptId:'fake-'+n};}},
    findReusableShots,planBatchStart,healPowerLossQueueEntries,planShotReferences,shotQueueH3Props,latestQueueRun,maySubmitQueueEntry,queueEntryUncertain,newQueueSession,queueNodePosition,queueRowKey,queueSessionKey,
    queueFramePlan,queueFrameDescription,assertQueueFrameRemoval,QueueFrameWaitingError,resolveQueueFrameInputs,frameEntriesToResume,hasQueueFrameSources,createQueueFrameRunObserver,releaseSettledSourceContinuations,rerunProbeAllows,
    retiredHeldAllows:async()=>false,enhanceQueueTailFrame:async()=>{throw Error('unused');},storeQueueFrame:async()=>'',getLocalVideoBlob:async()=>{throw Error('unused');},extractVideoFrameAt:async()=>{throw Error('unused');},extractVideoFirstFrame:async()=>{throw Error('unused');},
  });
  vm.runInContext(code,context);
  const api=context.useQueue({editor,queue,restore(){},message:m=>data.messages.push(m),origin:()=>({x:0,y:0}),persistenceKey:'STOP-TEST',focusNode:id=>data.focus.push(id),
    createNode:async(props,point)=>{const id='shape:s-'+(editor.shapes.size+1);editor.shapes.set(id,{id,type:'h3-node',props,...point,meta:{}});return{id};}});
  return{data,api,editor};
}
const until=async(cond,ms,what)=>assert.ok(await waitUntil(cond,ms,10),'timed out waiting for '+what);

// 4a. 现场：收件箱有 STOP，循环停在 waitForInboxRootControl（真的那一个，每 200ms 看一次）里一直等 → 点停止
{
  applyInboxRootControl(STOPPED);
  const h=harness();const run=h.api.submitAll();
  await until(()=>h.data.messages.some(m=>/根目录STOP生效/.test(m)),3000,'root STOP wait');
  assert.equal(h.api.isSubmitting(),true);
  const t0=Date.now();const result=await h.api.stop();
  assert.equal(result.exited,true);assert.ok(Date.now()-t0<3000,'几秒内停下，实际 '+(Date.now()-t0)+'ms');
  assert.equal(h.api.isSubmitting(),false,'界面解锁：提交循环已退出');
  await run;assert.equal(h.data.submitted.length,0,'没往 ComfyUI 提交');
  assert.match(h.data.messages.at(-1),/没有任何镜头提交到 ComfyUI/);assert.match(h.data.messages.at(-1),/卡片已解锁/);
}

// 4b. 提交循环里（不在 bounded 预建锁内）的根总控等待完全不响应（永远不 resolve、也不再调 guard）：abortable 让停止照样生效
{
  applyInboxRootControl(OPEN);
  let hb;const h=hb=harness({rootGate:()=>hb.data.messages.some(m=>/全部节点已创建/.test(m))?(hb.data.loopGate=true,new Promise(()=>{})):undefined});const run=h.api.submitAll();
  await until(()=>h.data.loopGate,3000,'unresponsive in-loop root gate');
  const t0=Date.now();const result=await h.api.stop();
  assert.equal(result.exited,true);assert.ok(Date.now()-t0<3000);assert.equal(h.api.isSubmitting(),false);
  await run;assert.equal(h.data.submitted.length,0);
}

// 4c. 节点建好了，卡在「节点就绪」轮询（80×150ms）里 → 点停止：退出、写停止标记、提示写明 3 镜都没提交
{
  applyInboxRootControl(OPEN);
  const h=harness({notReady:true});const run=h.api.submitAll();
  await until(()=>h.data.focus.length>0,5000,'node-ready poll');
  const t0=Date.now();const result=await h.api.stop();
  assert.equal(result.exited,true);assert.ok(Date.now()-t0<3000);assert.equal(h.api.isSubmitting(),false);
  await run;assert.equal(h.data.submitted.length,0);
  assert.ok(h.data.saved.stoppedAt,'停止标记写进本地记录');assert.equal(h.data.saved.autoContinueFrames,false);
  const last=h.data.messages.at(-1);assert.match(last,/已停止后续排队/);assert.match(last,/本批 3 镜/);assert.match(last,/没提交、不会再提交 3/);assert.match(last,/ComfyUI 里已经没有本批的任务/);assert.match(last,/卡片已解锁/);
  assert.ok(h.data.cancelCalls>=1,'只撤下本批排队（cancelPendingJobs），不中断正在跑的');
}

// 4d. 停不掉：循环卡在一个不看停止的本地读取里 → 6 秒后提示「强制解锁」；强制解锁后界面放开，卡住的那次放出来也不会再提交
{
  applyInboxRootControl(OPEN);
  let armed=false;
  const h=harness({hangListRuns:data=>{if(!armed&&data.messages.some(m=>/全部节点已创建/.test(m))){armed=true;return true;}return false;}});
  const run=h.api.submitAll();
  await until(()=>h.data.hung,5000,'hung local read');
  const t0=Date.now();const result=await h.api.stop();
  assert.equal(result.exited,false);assert.ok(Date.now()-t0>=STOP_EXIT_MS-200&&Date.now()-t0<STOP_EXIT_MS+4000,'按时给出强制解锁，实际 '+(Date.now()-t0)+'ms');
  assert.ok(h.data.messages.some(m=>/秒内没退出：可以点「强制解锁」/.test(m)));assert.match(h.data.messages.at(-1),/强制解锁/);
  assert.equal(h.api.isSubmitting(),true);
  h.api.forceUnlock();
  assert.equal(h.api.isSubmitting(),false,'强制解锁：界面放开');assert.match(h.data.messages.at(-1),/^已强制解锁/);
  h.data.releaseHang();await run;
  assert.equal(h.data.submitted.length,0,'卡住的那次放出来后不会再提交任何镜头');assert.equal(h.api.isSubmitting(),false,'旧循环收尾不会把新状态改回去');
}
applyInboxRootControl({...STOPPED});

// ── 5. 界面接线：顶栏按钮和抽屉按钮是同一个 execution.stop；锁用 queueLockState；强制解锁先问 ──
const panel=read('components/shot-queue-panel.tsx'),board=read('components/shot-card-board.tsx'),hook=read('components/use-shot-queue-execution.ts');
assert.match(panel,/const lock = queueLockState\(rows, busyChapter !== null, execution\.stoppedAt !== null\);/);
assert.doesNotMatch(panel,/busyChapter !== null \|\| execution\.hasActive/,'卡片锁不再包含「状态待确认」');
assert.match(panel,/const submitting = lock\.locked;/);
assert.match(panel,/stop: submitting \|\| execution\.stuck \? stopQueue : undefined/);
assert.match(panel,/const stopQueue = \(\) => \{ setDrawerOpen\(true\); void execution\.stop\(\); \};/,'停止先打开「JSON / 进度」，提示在眼前');
assert.match(panel,/askConfirm\(\{ title: "强制解锁？", message: FORCE_UNLOCK_NOTE/);
assert.match(board,/queueDrawer\.enqueue\.forceUnlock/);assert.match(board,/正在停止…/);
assert.doesNotMatch(hook.slice(hook.indexOf('const stop = async'),hook.indexOf('const removeEntry')),/interrupt|\/cancel/,'停止不取消 ComfyUI 里正在跑的任务');
assert.doesNotMatch(read('lib/queue-stop.ts'),/purple|violet|#7c3aed|#8b5cf6/i);
// ── 6. 用户明确「继续未完成」是清停止标记的唯一合法通道；旧执行器仍不能清/写回 ──
{
  const base=newQueueSession('page:resume',raw(),{x:0,y:0});base.revision=1;
  const stopped=structuredClone(base);stopped.stoppedAt=111;stopped.stopReason='用户停止';stopped.stopSource='user';stopped.autoContinueFrames=false;stopped.revision=2;
  const resumed=()=>{const r=structuredClone(stopped);r.stoppedAt=undefined;r.stopReason=undefined;r.stopSource=undefined;r.autoContinueFrames=true;return r;};
  // 不带 explicitResume：照旧拒绝
  assert.throws(()=>mergeSessionDelta(stopped,resumed(),stopped),{name:'SessionConflict'},'无 explicitResume 不能清停止标记');
  const staleClear=resumed();staleClear.entries[0].waitingReason='late';
  assert.throws(()=>mergeSessionDelta(stopped,staleClear,stopped),{name:'SessionConflict'},'旧尝试改镜头同时清标记也被拒');
  // 带 explicitResume：成功
  const ok=mergeSessionDelta(stopped,resumed(),stopped,{explicitResume:true});
  assert.equal(ok.stoppedAt,undefined);assert.equal(ok.stopReason,undefined);assert.equal(ok.stopSource,undefined);
  assert.equal(ok.autoContinueFrames,true);assert.equal(ok.revision,stopped.revision+1);
  const okWithEntry=resumed();okWithEntry.entries[0].waitingReason='healed';
  const ok2=mergeSessionDelta(stopped,okWithEntry,stopped,{explicitResume:true});
  assert.equal(ok2.stoppedAt,undefined);assert.equal(ok2.entries[0].waitingReason,'healed');assert.equal(ok2.autoContinueFrames,true);
  // 收件箱 stopSessions 的停止不放开
  const rootStopped=structuredClone(stopped);rootStopped.stopSource='root_stopSessions';
  assert.throws(()=>mergeSessionDelta(rootStopped,resumed(),rootStopped,{explicitResume:true}),{name:'SessionConflict'},'root_stopSessions 不能由界面恢复');
  // 恢复后，旧执行器拿着停止时的 before 回写：不能把停止标记写回，也不能覆盖恢复
  const late=structuredClone(stopped);late.entries[1].waitingReason='late-writer';
  const afterLate=mergeSessionDelta(ok,late,stopped);
  assert.equal(afterLate.stoppedAt,undefined,'旧执行器回写不把 stoppedAt 写回');assert.equal(afterLate.autoContinueFrames,true,'不覆盖恢复后的 autoContinueFrames');
  assert.equal(afterLate.revision,ok.revision+1);
  // 报错带原因，存储类错误保持原意
  const conflictMsg=new QueuePersistenceError(new (class SessionConflict extends Error{name='SessionConflict'})('文件停止标记不可被旧执行器清除')).message;
  assert.match(conflictMsg,/本地队列保存失败/);assert.match(conflictMsg,/文件停止标记不可被旧执行器清除/);
  const diskMsg=new QueuePersistenceError(Error('QuotaExceededError')).message;
  assert.match(diskMsg,/请检查浏览器存储空间/);assert.doesNotMatch(diskMsg,/原因/);
  // 接线：只有 explicitResume 分支传 true
  assert.match(hook,/await persist\(batch,prebuild\.signal,false,true\);/);
  assert.equal((hook.match(/persist\([^)]*false,true\)/g)??[]).length,1,'只有一处恢复写入传 explicitResume');
}
console.log('PASS queue-stop: 状态待确认不锁卡片；卡在根总控 STOP 等待 / 不响应的等待 / 节点就绪轮询时点停止，几秒内退出、解锁、提示停了几镜；停不掉 6 秒给强制解锁且之后不再提交；不取消 ComfyUI 里在跑的任务。CPU mocks only.');
