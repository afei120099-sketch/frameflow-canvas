import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { parseShotQueue } from '../lib/shot-queue.ts';
import { inboxProgress, validateInboxQueue } from '../lib/inbox-queue-report.ts';
import {rolloutProtectsQueue,rolloutProtectsCommand} from '../lib/inbox-rollout-guard.ts';
import {inboxReceiptBlocks,pageSlotHasWork} from '../lib/inbox-blocking-policy.ts';
import {assertInboxHandoffNotStarted} from '../lib/inbox-handoff-retry.ts';
import { latestQueueRun, queueEntryUncertain } from '../lib/shot-queue-session.ts';
import { inboxHandoffExpired, beginInboxRequest, matchingInboxRequest, reportInboxRequest, blockInboxRequest } from '../lib/inbox-queue-protocol.ts';
import { harness as queueHarness } from './test-queue-fail-closed.mjs';

const raw={version:'shot-queue-v1',title:'CPU isolated inbox',chapters:[{title:'one',shots:[{title:'one',prompt:'CPU test only',roleIds:[],sceneAssetIds:[],seconds:6,aspect:'16:9',soundMode:'ambient',autoVoiceDisabled:true}]}]};
const parsed=parseShotQueue(JSON.stringify(raw));
const source=readFileSync('components/use-inbox-scheduler.ts','utf8').replace(/^import .*;\r?\n/gm,'').replace('export function useInboxScheduler','function useInboxScheduler');
const code=ts.transpileModule(source+'\nglobalThis.useInbox=useInboxScheduler;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
export async function harness({receipts={},paused=false,sessions=[],runs=[],assets=[],roles=[],ack:initialAck,failWrite=false,lock=true,command,controller,extraFiles={},corruptProject=false,rootControl={stop:false,error:null,effective:{autoEnqueue:true,autoChain:true,submit:true}}}={}) {
  const metadata=new Map();
  const state={images:{},queues:structuredClone(receipts)},disk=new Map([['_inbox_state.json',state],['new_queue.json',raw]]);
  for(const [name,value] of Object.entries(extraFiles))disk.set(name,value);
  if(paused)disk.set('_inbox_control.json',{paused:true,reason:'explicit user hold'});
  if(command)disk.set('_inbox_command.json',command);
  const data={handoffs:0,imports:0,statuses:[],warnings:[],ack:initialAck,rootControl}; let timer,cleanup;
  const editor={getPages:()=>[{id:'page:target'}],getCurrentPageId:()=> 'page:target',getPageShapeIds:()=>[],getShape(){}};
  const context=vm.createContext({console:{warn:(...args)=>data.warnings.push(args)},JSON,Date,Set,Map,Promise,Error,crypto,AbortSignal,URLSearchParams,File,Blob,
    checkQueueGate:async()=>({ok:true}),
    queueCardReport:()=>null,
    switchInboxPage:async()=>{},
    noteInboxStateHealth(){},
    noteInboxSchedulerTick(){},
    readInboxRootSnapshot:()=>data.rootControl,
    useRef:value=>({current:value}),useEffect:fn=>{cleanup=fn();},setInterval:fn=>{timer=fn;return 1;},clearInterval(){},
    navigator:{locks:{request:async(_name,_opts,fn)=>fn(lock?{}:null)}},
    window:{},runInboxDelete:async()=>{},
    assertInboxHandoffNotStarted,listCleanupMetadata:async()=>sessions.map(s=>({key:'shot-queue-session-v1:'+s.pageId,value:s})),listRuns:async()=>runs,getMeta:async key=>metadata.get(key)??sessions.find(s=>key.endsWith(s.pageId))??null,putMeta:async(key,value)=>metadata.set(key,structuredClone(value)),queueSessionKey:id=>'session:'+id,
    inboxReceiptBlocks,pageSlotHasWork,rolloutProtectsQueue,rolloutProtectsCommand,latestQueueRun,queueEntryUncertain,parseShotQueue,inboxHandoffExpired,inboxProgress,validateInboxQueue,listAssets:async()=>assets,listAllAssets:async()=>assets,listRoles:async()=>roles,
    readInboxRecovery:()=>controller,
    beginInboxRequest:r=>{data.ack=r;},readInboxRequest:()=>data.ack,blockInboxRequest:(id,error)=>{if(data.ack?.id===id)Object.assign(data.ack,{phase:'blocked',error});},
    fetch:async(input,opts={})=>{
      if(input==='/__inbox/artifacts')return{ok:true,json:async()=>({ok:true})};
      const q=new URL(input,'http://localhost').searchParams,op=q.get('op'),name=q.get('name');
      if(op==='projects')return{ok:true,json:async()=>({projects:corruptProject?['corrupt','isolated']:['isolated']})};
      if(op==='list')return{ok:true,json:async()=>({files:[...disk.keys()].map(name=>({name,kind:/_(queue|validate)\.json$/.test(name)?'queue':'other',...(/_(queue|validate)\.json$/.test(name)?{sha256:name==='new_queue.json'?'new-hash':JSON.stringify(disk.get(name))}:{})}))})};
      if(op==='write'){
        if(failWrite)throw Error('fake disk full');
        const value=JSON.parse(opts.body);disk.set(name,value);
        if(name.endsWith('_status.json'))data.statuses.push(value);
        return{ok:true,json:async()=>({ok:true})};
      }
      if(op==='file')return{ok:true,json:async()=>{if(q.get('project')==='corrupt'&&name==='_inbox_state.json')throw new SyntaxError('Unexpected null byte');return structuredClone(disk.get(name));}};
      throw Error('unexpected endpoint '+op);
    },
  });
  vm.runInContext(code,context);
  context.useInbox(editor,async()=>{data.imports++;return{assetId:'image'};},()=>{data.handoffs++;},async()=>false,()=>[]);
  const settle=async()=>{for(let i=0;i<100;i++)await new Promise(resolve=>setImmediate(resolve));};
  await settle();
  return{data,disk,async tick(){timer();await settle();},cleanup};
}

const legacy={old:{file:'old_queue.json',at:'2000-01-01T00:00:00Z',result:'submitted',queueJson:JSON.stringify(parsed)}};
const stalled=await harness({receipts:legacy});
assert.equal(stalled.data.handoffs,0);
assert.equal(stalled.disk.get('new_queue_status.json').state,'skipped','missing-source history no longer blocks, but identical canonical queue still cannot replay');
assert.equal(stalled.disk.get('old_queue_status.json').state,'blocked');
await stalled.tick();assert.equal(stalled.data.handoffs,0,'blocked receipt never replays');

const held=await harness({paused:true});
assert.equal(held.data.handoffs,0);assert.equal(held.disk.get('new_queue_status.json').state,'waiting');
const normal=await harness();
assert.equal(normal.data.handoffs,1);assert.equal(normal.disk.get('_inbox_state.json').queues['new-hash'].result,'preparing');
assert.ok(normal.data.statuses.some(s=>s.state==='received'));assert.ok(normal.data.statuses.some(s=>s.state==='preparing'));
await normal.tick();assert.equal(normal.data.handoffs,1,'no duplicate handoff while awaiting acknowledgment');

const expired={old:{file:'old_queue.json',at:'2000-01-01T00:00:00Z',result:'preparing',pageId:'page:target',requestId:'old',queueJson:JSON.stringify(parsed)}};
const timeout=await harness({receipts:expired,ack:{id:'old',phase:'preparing'}});
assert.equal(timeout.disk.get('old_queue_status.json').state,'awaiting_session');assert.equal(timeout.data.handoffs,0);
assert.equal(timeout.data.ack?.phase,'preparing','timeout must not poison a delayed live acknowledgment');
const session={id:'fixed-session',pageId:'page:target',queue:parsed,entries:[{chapter:0,shot:0,nodeId:'shape:one'}]};
const active={old:{...expired.old,result:'submitting',sessionId:'fixed-session'}};
const finished=await harness({receipts:active,paused:true,sessions:[session],assets:[{assetId:'video',kind:'video',storageReference:'video:output',filename:'output.mp4'}],runs:[{ownerNodeId:'shape:one',runId:'r',comfyPromptId:'p',status:'completed',createdAt:1,outputAssetIds:['video']}]});
assert.equal(finished.disk.get('old_queue_status.json').state,'completed');assert.equal(finished.disk.get('old_queue_status.json').shots[0].promptId,'p');
const failed=await harness({receipts:active,paused:true,sessions:[session],runs:[{ownerNodeId:'shape:one',runId:'r',comfyPromptId:'p',status:'failed',createdAt:1}]});
assert.equal(failed.disk.get('old_queue_status.json').state,'finished_with_errors');
const changed=await harness({receipts:active,sessions:[{...session,id:'different-session'}]});
assert.equal(changed.disk.get('old_queue_status.json').state,'blocked','never follow another session on same page');
const prepError=await harness({receipts:expired,ack:{id:'old',phase:'blocked',error:'missing role'}});
assert.equal(prepError.disk.get('old_queue_status.json').error,'missing role');assert.equal(prepError.data.handoffs,0);
const noLock=await harness({lock:false});assert.equal(noLock.data.handoffs,0);
const noWrite=await harness({failWrite:true});assert.equal(noWrite.data.handoffs,0);
const commandTarget={commandId:'one-shot',requestId:'blocked-request',sessionId:'fixed-session',pageId:'page:target',action:'resume'};
const blockedReceipt={old:{file:'old_queue.json',at:'2000-01-01T00:00:00Z',result:'blocked',pageId:'page:target',sessionId:'fixed-session',requestId:'blocked-request',queueJson:JSON.stringify(parsed)}};
let resumes=0;
const commandRun=await harness({receipts:blockedReceipt,paused:true,sessions:[session],command:commandTarget,controller:{diagnose:async()=>({matches:true}),resume:async()=>{resumes++;}}});
assert.equal(resumes,1);assert.equal(commandRun.disk.get('_inbox_command_status.json').state,'accepted');
await commandRun.tick();assert.equal(resumes,1,'the same command never replays');
const wrongCommand=await harness({receipts:blockedReceipt,paused:true,sessions:[session],command:{...commandTarget,requestId:'wrong'},controller:{resume:async()=>resumes++}});
assert.equal(wrongCommand.disk.get('_inbox_command_status.json').state,'rejected');assert.equal(resumes,1);
let mixedResumes=0;
const mixed=await harness({receipts:{old:{...blockedReceipt.old,result:'running'}},paused:true,sessions:[session],ack:{id:'blocked-request',sessionId:'fixed-session',phase:'blocked',error:'HTTP 502'},command:commandTarget,controller:{resume:async()=>mixedResumes++}});
assert.equal(mixedResumes,1,'running GPU jobs do not hide a blocked original submission controller from explicit scoped resume');
assert.equal(mixed.disk.get('_inbox_command_status.json').state,'accepted');mixed.cleanup();
const duplicate=await harness({receipts:{old:{file:'prior_queue.json',result:'archived_no_live_task',queueJson:JSON.stringify(parsed),at:'2000-01-01T00:00:00Z'}}});
assert.equal(duplicate.data.handoffs,0);assert.equal(duplicate.disk.get('new_queue_status.json').state,'skipped');

for(const h of [stalled,held,normal,timeout,finished,failed,changed,prepError,noLock,noWrite,duplicate])h.cleanup();
globalThis.window={};
beginInboxRequest({id:'cpu',pageId:'page:target',queueJson:JSON.stringify(parsed),phase:'preparing'});
assert.equal(matchingInboxRequest('page:other',parsed),undefined);
reportInboxRequest('page:target',parsed,'session_created',{sessionId:'fixed'});
assert.equal(matchingInboxRequest('page:target',parsed).sessionId,'fixed');
blockInboxRequest('cpu','timeout');reportInboxRequest('page:target',parsed,'submitting');
assert.equal(matchingInboxRequest('page:target',parsed).phase,'blocked','late preparation cannot revive a timed-out request');
delete globalThis.window;
const actualReports=[];
const actualBlocked=queueHarness({hooks:{inboxRequest:{phase:'blocked'}}});
await actualBlocked.api.submitAll();
assert.equal(actualBlocked.data.submitted.length,0);assert.equal(actualBlocked.data.created.length,0);
const actualSubmit=queueHarness({hooks:{inboxReport:(...r)=>actualReports.push(r)}});
await actualSubmit.api.submitAll();
assert.ok(actualReports.some(r=>r[2]==='session_created'&&r[3].sessionId));
assert.ok(actualReports.some(r=>r[2]==='submitting'));
const l00Queue=parseShotQueue(JSON.stringify({...raw,title:'L00 file session'}));
const episode={id:'episode',pageId:'page:target',autoContinueFrames:true,queue:parsed,entries:[{chapter:0,shot:0,nodeId:'shape:ep',waitingReason:'等待尾帧'}]};
const l00={id:'l00',pageId:'page:target',autoContinueFrames:true,version:1,queue:l00Queue,entries:[{chapter:0,shot:0,nodeId:'shape:l00',submissionState:'accepted'}]};
const displaced=await harness({sessions:[episode,l00],runs:[{ownerNodeId:'shape:l00',runId:'run-l00',comfyPromptId:'prompt-l00',status:'queued',submission:'accepted',createdAt:1}],receipts:{
  'l00-hash':{file:'l00_queue.json',at:'2000-01-01T00:00:00Z',result:'blocked',pageId:'page:target',sessionId:'l00',requestId:'l00-req',queueJson:JSON.stringify(l00Queue),contentHash:'l00-hash',error:'原会话暂不可核实',details:{confirmationPending:true,note:'尚未确认目标页会话'}},
  'new-hash':{file:'new_queue.json',at:new Date().toISOString(),result:'waiting',requestId:'new',contentHash:'new-hash',details:{note:'等待处理前批：l00_queue.json'}},
}});
assert.equal(displaced.data.handoffs,0,'busy page slot is not replaced');
assert.equal(displaced.disk.get('l00_queue_status.json').state,'running');
assert.equal(displaced.disk.get('l00_queue_status.json').sessionId,'l00');
assert.equal(displaced.disk.get('l00_queue_status.json').shots[0].state,'queued');
assert.equal(displaced.disk.get('l00_queue_status.json').pageSlotDisplaced,true);
assert.equal(pageSlotHasWork(episode,[]),true);
assert.doesNotMatch(displaced.disk.get('new_queue_status.json').note,/等待处理前批/);
assert.match(displaced.disk.get('new_queue_status.json').note,/episode/);
displaced.cleanup();
assert.equal(inboxHandoffExpired('invalid'),true);
assert.equal(inboxHandoffExpired(new Date().toISOString()),false);
console.log('PASS inbox scheduler: received/waiting, legacy blocked/no replay, explicit hold, single handoff, timeout, fixed session, prompt IDs, terminal failures, preparation error, cross-tab lock, disk failure; CPU mocks only');
