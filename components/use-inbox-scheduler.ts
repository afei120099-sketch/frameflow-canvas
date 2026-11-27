"use client";
import { queueCardReport } from "@/lib/shot-card-report";
import { checkQueueGate } from "@/components/gate-check";
import { useEffect, useRef } from "react";
import type { Editor } from "tldraw";
import { getMeta, putMeta, listRuns, listAssets, listAllAssets, listCleanupMetadata } from "@/lib/production-records";
import { assertInboxHandoffNotStarted } from '@/lib/inbox-handoff-retry';
import {readInboxRootSnapshot} from '@/lib/inbox-root-control';
import { listRoles } from "@/lib/role-records";
import { inboxProgress, validateInboxQueue } from "@/lib/inbox-queue-report";
import {rolloutProtectsQueue,rolloutProtectsCommand,type InboxRolloutGuard} from '@/lib/inbox-rollout-guard';
import { inboxReceiptBlocks, pageSlotHasWork } from '@/lib/inbox-blocking-policy';
import { parseShotQueue } from "@/lib/shot-queue";
import { latestQueueRun, queueEntryUncertain, queueSessionKey, type QueueSession } from "@/lib/shot-queue-session";
import { beginInboxRequest, blockInboxRequest, inboxHandoffExpired, readInboxRequest, readInboxRecovery } from "@/lib/inbox-queue-protocol";
import { runInboxDelete } from "./inbox-delete";
import {switchInboxPage} from '@/lib/inbox-page-switch';
import {noteInboxStateHealth} from '@/lib/inbox-state-health';
import {noteInboxSchedulerTick} from '@/lib/inbox-executor-presence';

type FileInfo = { name: string; kind: string; sha256?: string };
type Receipt = { cardsOnly?: boolean; file: string; at: string; result: string; queueJson?: string; pageId?: string; sessionId?: string; requestId?: string; error?: string; audit?: unknown; saveDiagnosticAt?:string; handledCommands?:string[]; validateOnly?:boolean; contentHash?:string; details?:Record<string,unknown>;userHeld?:boolean };
type State = { images: Record<string, {sha256: string; assetId: string; placedOn?: string[]}>; queues: Record<string, Receipt> };
const url = (params: Record<string, string>) => `/api/inbox?${new URLSearchParams(params)}`;
async function json<T>(params: Record<string, string>, body?: unknown): Promise<T> {
  const response = await fetch(url(params), { cache: "no-store", ...(body !== undefined ? {method: "POST", body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw Error(`收件箱 ${params.op}: HTTP ${response.status}`);
  return response.json();
}
async function write(project: string, name: string, value: unknown): Promise<void> { await json({op:"write", project, name}, value); }
async function optional<T>(project: string, name: string, files: FileInfo[]) {
  return files.some(f => f.name === name) ? json<T>({op:"file",project,name}) : null;
}
async function readProjectState(project:string,files:FileInfo[]){
 try{
  const state=await optional<State>(project,'_inbox_state.json',files)??{images:{},queues:{}};
  if(!state||!state.images||!state.queues||typeof state.images!=='object'||typeof state.queues!=='object'||Array.isArray(state.images)||Array.isArray(state.queues))throw Error('状态必须含images和queues映射');
  noteInboxStateHealth(project);return state;
 }catch(error){noteInboxStateHealth(project,error);return null;}
}
type PageHint = { pageId?: unknown; pageName?: unknown; targetPage?: unknown; autoSwitchPage?: boolean };
function inboxTargetPage(editor: Editor, source: PageHint) {
  const pages = editor.getPages();
  const explicit = typeof source.pageId === "string" ? source.pageId.trim() : "";
  if (explicit) {
    const hit = pages.find(page => page.id === explicit);
    return { pageId: hit?.id ?? null, label: hit?.name?.trim() || explicit };
  }
  const named = (typeof source.pageName === "string" ? source.pageName : typeof source.targetPage === "string" ? source.targetPage : "").trim();
  if (named) {
    const hit = pages.find(page => (page.name ?? "").trim() === named);
    return { pageId: hit?.id ?? null, label: named };
  }
  const current = editor.getCurrentPageId();
  const page = pages.find(item => item.id === current);
  return { pageId: current || null, label: page?.name?.trim() || "当前页" };
}
const ACTIVE = new Set(["awaiting_session", "preparing", "session_created", "submitting", "running"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "uncertain"]);

export function useInboxScheduler(editor: Editor, onImportImage: (file: File) => Promise<{assetId:string}>, onQueue: (text:string,deliveryId?:string)=>void,
  placeImages: (editor:Editor, state:State)=>Promise<boolean>, resolveNames: (queue:unknown,map:Record<string,string>)=>string[]) {
  const live = useRef({ onImportImage, onQueue });
  useEffect(() => { live.current = { onImportImage, onQueue }; });
  useEffect(() => {
    let stopped = false, busy = false;
    const lastStateJson = new Map<string, string>();
    const lastStatusJson = new Map<string, string>();
    const statusFingerprint = (payload: Record<string, unknown>) => {
      const { updatedAt: _ignored, ...rest } = payload;
      return JSON.stringify(rest);
    };
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        if (!navigator.locks) throw Error("浏览器不支持收件箱跨标签锁，禁止自动提交");
        await navigator.locks.request("frameflow-inbox-scheduler-v2", {ifAvailable:true}, async lock => {
          if (!lock || stopped) return;
          noteInboxSchedulerTick(); // observed only: shows 「本页是执行页」, never changes who runs
          const { projects } = await json<{projects:string[]}>({op:"projects"});
          const runs = await listRuns();
          // One small session record per page. Shape props and media blobs are not read here.
          const sessions = (await Promise.all(editor.getPages().map(p => getMeta<QueueSession>(queueSessionKey(p.id))))).filter((s):s is QueueSession=>!!s);
          let assetList: Awaited<ReturnType<typeof listAllAssets>> | null = null;
          let cleanupMetadataCache: Awaited<ReturnType<typeof listCleanupMetadata>> | null = null;
          const getCleanupMetadata = async () => (cleanupMetadataCache ??= await listCleanupMetadata());
          // A different inbox project may already own a batch after a reload.
          const existingReceipts = await Promise.all(projects.map(async project => {
            const {files} = await json<{files:FileInfo[]}>({op:"list",project});
            const state=await readProjectState(project,files);
            return {files,guard:await optional<InboxRolloutGuard>(project,'_inbox_rollout_guard.json',files),queues:state?.queues??{},unreadable:state===null};
          }));
          const otherActive = existingReceipts.flatMap(({files,guard,queues},index)=>Object.entries(queues).filter(([hash,r])=>inboxReceiptBlocks(r,files.some(f=>f.name===r.file&&f.sha256===(r.contentHash??hash)),rolloutProtectsQueue(guard,r.contentHash??hash),sessions,runs)).map(([,r])=>({project:projects[index],receipt:r})));
          for (const project of projects) {
            const { files } = await json<{files:FileInfo[]}>({op:"list",project});
            const state = await readProjectState(project,files);
            if(!state)continue; // Never replace corrupt receipts with an empty queue, nor block healthy project commands.
            state.images ??= {}; state.queues ??= {};
            const rollout=await optional<InboxRolloutGuard>(project,'_inbox_rollout_guard.json',files);
            const control=await optional<{paused?:boolean;reason?:string;heldQueueHashes?:string[]}>(project,"_inbox_control.json",files);
            for(const [hash,r] of Object.entries(state.queues))if(!r.validateOnly&&control?.heldQueueHashes?.includes(r.contentHash??hash)&&!['completed','finished_with_errors','rejected','superseded','skipped'].includes(r.result)){r.userHeld=true;r.result='stopped';}
            const stateFileExists = files.some(f => f.name === "_inbox_state.json");
            if (stateFileExists && !lastStateJson.has(project)) {
              lastStateJson.set(project, JSON.stringify(state));
            }
            const save = async () => {
              const serialized = JSON.stringify(state);
              if (stateFileExists && lastStateJson.get(project) === serialized) return;
              await write(project,"_inbox_state.json",state);
              lastStateJson.set(project, serialized);
            };
            const status = async (r:Receipt, extra:Record<string,unknown> = {}) => {
              const current=files.find(f=>f.name===r.file&&f.sha256);
              const hash=r.contentHash??Object.entries(state.queues).find(([,receipt])=>receipt===r)?.[0];
              // Older contents of the same filename must never overwrite this generation's receipt.
              if(current && hash && current.sha256!==hash)return;
              if(r.result!=='waiting'&&r.result!=='missing_assets'&&typeof r.details?.note==='string'&&r.details.note.startsWith('等待处理前批')&&!('note' in extra))r.details={...r.details,note:r.error?`当前阻塞：${r.error}`:`当前状态：${r.result}，已重新判定，不沿用旧等待原因`};
              r.details={...r.details,...extra};
              await save();
              const statusName = r.file.replace(/\.json$/i,"_status.json");
              const statusKey = `${project}\0${statusName}`;
              const statusExists = files.some(f => f.name === statusName);
              if (statusExists && !lastStatusJson.has(statusKey)) {
                const diskStatus = await optional<Record<string, unknown>>(project, statusName, files).catch(() => null);
                if (diskStatus && typeof diskStatus === "object") {
                  lastStatusJson.set(statusKey, statusFingerprint(diskStatus));
                }
              }
              const payload: Record<string, unknown> = {
                ...r.details,
                queue:r.file, state:r.result, pageId:r.pageId ?? null, sessionId:r.sessionId ?? null,
                requestId:r.requestId ?? null, error:r.error ?? null, updatedAt:new Date().toISOString(), contentHash:hash??current?.sha256??null,sourceFilePresent:!!current,
              };
              const fp = statusFingerprint(payload);
              if (statusExists && lastStatusJson.get(statusKey) === fp) return;
              await write(project, statusName, payload);
              lastStatusJson.set(statusKey, fp);
            };
            // Always acknowledge discovery, even when an earlier handoff is stuck.
            for (const f of files.filter(f => f.kind === "queue" && f.sha256)) {
              let validationFile=/_validate\.json$/i.test(f.name);
              // 镜头卡片：*_cards.json 或 "cardsOnly": true —— 只放进卡片给人看/改，不提交 GPU（走干跑分支）。
              let cardsFile=/_cards\.json$/i.test(f.name);
              try{const data=await json<{validateOnly?:unknown;cardsOnly?:unknown}>({op:'file',project,name:f.name});validationFile ||= data?.validateOnly===true;cardsFile ||= data?.cardsOnly===true;}catch{/* malformed JSON is reported during validation */}
              if(cardsFile)validationFile=true;
              const receiptKey=f.sha256!+(cardsFile?':cards':validationFile?':validate':'');
              const existing=state.queues[receiptKey];
              if (existing) {
                if (existing.file!==f.name) await status({...existing,file:f.name,result:"skipped"},{duplicateOf:existing.file,duplicateHash:f.sha256,originalResult:existing.result,note:`与 ${f.sha256} 相同，原文件 ${existing.file} 已 ${existing.result}，不重复提交`});
                else await status(existing); // Repair a stale/missing status, including terminal receipts.
                continue;
              }
              const r:Receipt = {file:f.name,at:new Date().toISOString(),result:"received",requestId:crypto.randomUUID(),validateOnly:validationFile,...(cardsFile?{cardsOnly:true}:{}),contentHash:f.sha256};
              state.queues[receiptKey] = r;
              await save(); await status(r);
              r.result = "waiting"; await save(); await status(r,{note:"已接收，等待调度；尚未提交GPU"});
            }
            const map = await optional<Record<string,string>>(project,"assets_map.json",files) ?? {};
            for (const f of files.filter(f => f.kind === "image" && f.sha256)) {
              if (state.images[f.name]?.sha256 === f.sha256 && map[f.name]) continue;
              const response = await fetch(url({op:"file",project,name:f.name}), {signal:AbortSignal.timeout(30_000)});
              if (!response.ok) throw Error(`图片读取失败：${f.name}`);
              const type = /\.png$/i.test(f.name) ? "image/png" : /\.webp$/i.test(f.name) ? "image/webp" : "image/jpeg";
              const asset = await live.current.onImportImage(new File([await response.blob()],f.name,{type}));
              map[f.name] = asset.assetId; state.images[f.name] = {sha256:f.sha256!,assetId:asset.assetId};
              await write(project,"assets_map.json",map); await save();
            }
            // The 2026-10-19 one-shot 仙侠 relocation is retired: its backup file is not on the inbox write
            // whitelist, so it retried every scan, and running it now would rearrange the curated 仙侠 page.
            if (await placeImages(editor,state)) await save();
            await runInboxDelete(editor,project,files,write);
            // Local one-shot command: never edit a receipt or clear the global claim gate to resume.
            const command=await optional<{action:string;commandId:string;pageId:string;sessionId:string;requestId:string;nodeId?:string;lineIndex?:number;expectedRoleId?:string;expectedText?:string;edge?:'first'|'last';output?:import('@/lib/tail-frame-output-recovery').TailOutputRecovery}>(project,"_inbox_command.json",files);
            if(command&&rolloutProtectsCommand(rollout,command.commandId)){
              await write(project,'_inbox_command_status.json',{commandId:command.commandId,state:'held',pageId:command.pageId,sessionId:command.sessionId,requestId:command.requestId,updatedAt:new Date().toISOString(),note:'上线前的旧命令仅保留，不自动重放；需要新的明确操作与新commandId'});
            }else if(command&&(!readInboxRootSnapshot().effective.submit||readInboxRootSnapshot().stop)&&!['diagnose_handoff','diagnose','cancel_shot','recover_tail_output'].includes(command.action)){
              await write(project,'_inbox_command_status.json',{commandId:command.commandId,state:'waiting_control',updatedAt:new Date().toISOString(),note:'根总控未开放提交；尚未消费此命令，也未提交GPU'});
            }else if(command?.action==='recover_tail_output'){
              const respond=(value:Record<string,unknown>)=>write(project,'_inbox_command_status.json',{commandId:command.commandId,requestId:command.requestId,pageId:command.pageId,sessionId:command.sessionId,updatedAt:new Date().toISOString(),...value});
              try{
                const batch=sessions.find(s=>s.id===command.sessionId&&s.pageId===command.pageId),entry=batch?.entries.find(e=>e.nodeId===command.nodeId);
                if(!command.commandId||!batch||!entry||entry.rerun?.requestId!==command.requestId||!command.output||!['first','last'].includes(command.edge??''))throw Error('恢复命令必须匹配原page/session/node/重渲requestId及明确输出证据');
                const key='inbox-tail-recovery:'+batch.id+':'+command.commandId,prior=await getMeta<Record<string,unknown>>(key);
                if(prior?.state==='recovered_not_submitted'){await respond(prior);continue;}
                const controller=readInboxRecovery(command.pageId);if(!controller?.recoverTail)throw Error('原页恢复控制器尚未就绪');
                const result=await controller.recoverTail({sessionId:command.sessionId,pageId:command.pageId,nodeId:command.nodeId!,edge:command.edge!,output:command.output}) as Record<string,unknown>;
                await putMeta('inbox-file-location:'+batch.id,{project,requestId:command.requestId,source:'verified_tail_recovery',at:new Date().toISOString()});
                await putMeta(key,result);await respond(result);
              }catch(error){await respond({state:'blocked',error:String(error)});}
            }else if(command){
              const receipt=Object.values(state.queues).find(r=>r.requestId===command.requestId && r.pageId===command.pageId && ((r.sessionId??'')===command.sessionId || command.action==='retry_handoff'&&r.handledCommands?.includes(command.commandId)));
              if(!receipt){await write(project,"_inbox_command_status.json",{state:"rejected",error:"没有匹配的原请求/页/会话，未创建任务"});}
              else if(command.action==='retry_handoff'&&receipt.handledCommands?.includes(command.commandId)&&receipt.sessionId&&sessions.some(s=>s.id===receipt.sessionId&&s.pageId===receipt.pageId)){
                await write(project,'_inbox_command_status.json',{commandId:command.commandId,requestId:command.requestId,sessionId:receipt.sessionId,state:'handoff_retried',updatedAt:new Date().toISOString(),note:'原唯一重交命令已处理且新会话已确认；只修复回执，不再次交接或提交'});
              }
              else if(!receipt.handledCommands?.includes(command.commandId)){
                const response=(value:Record<string,unknown>)=>write(project,"_inbox_command_status.json",{commandId:command.commandId,requestId:command.requestId,sessionId:command.sessionId,updatedAt:new Date().toISOString(),...value});
                // Consume intent before any side effect: a crash/reload cannot replay a resume command.
                receipt.handledCommands=[...(receipt.handledCommands??[]),command.commandId];await save();
                try{
                  if(!command.commandId || !["diagnose_handoff","diagnose","resume","resume_preparation","voice_none","retry_failed","cancel_shot","retry_handoff"].includes(command.action))throw Error("命令需要唯一commandId与有效动作");
                  if(receipt.userHeld&&!['diagnose_handoff','diagnose','cancel_shot','recover_tail_output'].includes(command.action))throw Error('此批次由用户明确停止；总开关打开不会恢复它。需要单独解除该批次hold。');
                  if(editor.getCurrentPageId()!==command.pageId)throw Error("请保持该命令指定的页面打开；不会自动切页");
                  if(command.action==='diagnose_handoff'){
                    const metadata=await getCleanupMetadata();
                    const allSessions=metadata.filter(r=>/^shot-queue-(session|file-v2)/.test(r.key)&&r.value&&typeof r.value==='object'&&'queue' in r.value).map(r=>r.value as QueueSession);
                    const q=JSON.parse(receipt.queueJson??'{}'),prompts=new Set<string>((q.chapters??[]).flatMap((c:{shots:{prompt:string}[]})=>c.shots.map(s=>s.prompt)));
                    const nodes=editor.getPages().flatMap(p=>[...editor.getPageShapeIds(p.id)].map(id=>editor.getShape(id)).filter(s=>s&&prompts.has((s.props as {prompt?:string}).prompt??'')).map(s=>({nodeId:s!.id,pageId:p.id})));
                    const matchedRuns=(await listRuns()).filter(run=>nodes.some(n=>n.nodeId===run.ownerNodeId)||!!run.rawPrompt&&prompts.has(run.rawPrompt));
                    const host=window as Window & {__ffShotQueueBoot?:{status:string};__ffShotQueueRun?:boolean};const ack=readInboxRequest();let safe=false,reason='';
                    try{assertInboxHandoffNotStarted(receipt,allSessions,await listRuns(),ack?.id===receipt.requestId?ack:undefined,host.__ffShotQueueBoot,host.__ffShotQueueRun);if(nodes.length)throw Error('发现原提示词节点，不按全新交接处理');safe=true;}catch(error){reason=String(error);}
                    await response({state:'handoff_diagnosed',audit:{checkedAt:new Date().toISOString(),safeToRetry:safe,reason,nodes,sessions:allSessions.filter(s=>JSON.stringify(s.queue)===receipt.queueJson).map(s=>({sessionId:s.id,pageId:s.pageId})),runs:matchedRuns.map(run=>({runId:run.runId,nodeId:run.ownerNodeId,promptId:run.comfyPromptId,status:run.status,createdAt:run.createdAt}))}});continue;
                  }
                  if(command.action==='retry_handoff'){
                    const file=files.find(f=>f.name===receipt.file&&f.kind==='queue'&&f.sha256===receipt.contentHash);
                    if(!file||rolloutProtectsQueue(rollout,receipt.contentHash))throw Error('原文件缺失、被覆盖或受保护，禁止重新交接');
                    const host=window as Window & {__ffShotQueueBoot?:{status:string};__ffShotQueueRun?:boolean};
                    const metadata=await getCleanupMetadata();
                    const allSessions=metadata.filter(r=>/^shot-queue-(session|file-v2)/.test(r.key)&&r.value&&typeof r.value==='object'&&'queue' in r.value).map(r=>r.value as QueueSession);
                    const ack=readInboxRequest();
                    assertInboxHandoffNotStarted(receipt,allSessions,await listRuns(),ack?.id===receipt.requestId?ack:undefined,host.__ffShotQueueBoot,host.__ffShotQueueRun);
                    const q=JSON.parse(receipt.queueJson!),prompts=new Set<string>(q.chapters.flatMap((c:{shots:{prompt:string}[]})=>c.shots.map(s=>s.prompt)));
                    if(editor.getPages().some(p=>[...editor.getPageShapeIds(p.id)].some(id=>{const shape=editor.getShape(id);return shape&&prompts.has((shape.props as {prompt?:string}).prompt??'');})))throw Error('存在原提示词节点，禁止重复预建');
                    receipt.result='preparing';receipt.error=undefined;receipt.at=new Date().toISOString();
                    await status(receipt,{note:'已核实原交接未创建会话/Run，按用户唯一命令重新交接；尚不代表GPU接单'});
                    beginInboxRequest({id:receipt.requestId!,pageId:command.pageId,queueJson:receipt.queueJson!,phase:'preparing'});
                    delete host.__ffShotQueueBoot;host.__ffShotQueueRun=false;
                    if(!stopped)live.current.onQueue(JSON.stringify(JSON.parse(receipt.queueJson!),null,2),command.commandId);
                    await response({state:'handoff_retried',note:'只重新交接未建会话的请求；请继续核对sessionId和promptId，不代表GPU接单'});
                    return;
                  }
                  const controller=readInboxRecovery(command.pageId);if(!controller)throw Error("原队列控制器尚未就绪");
                  if(command.action==='retry_failed'||command.action==='cancel_shot'){
                    if(!command.nodeId)throw Error('单镜操作需要原nodeId');
                    const result=await controller.shotAction({...command,nodeId:command.nodeId,action:command.action});
                    await response({state:'handled',result,note:'单镜操作回执不代表已完成渲染；请核对逐镜状态和产物'});
                  }else if(command.action==="diagnose"){
                    const diagnostic=await controller.diagnose(command.sessionId);
                    await write(project,receipt.file.replace(/\.json$/i,"_save_diagnostic_status.json"),diagnostic);
                    await response({state:"diagnosed",diagnostic});
                  }else if(command.action==='voice_none'){
                    if(!command.nodeId||!Number.isInteger(command.lineIndex)||!command.expectedRoleId||!command.expectedText)throw Error('单句修改需要原节点/行号/角色/台词核对');
                    const result=await controller.voiceNone({...command,nodeId:command.nodeId,lineIndex:command.lineIndex!,expectedRoleId:command.expectedRoleId,expectedText:command.expectedText});
                    await response({state:'voice_updated',result});
                  }else{
                    const liveRequest=readInboxRequest();
                    const originalSubmissionBlocked=!!liveRequest&&liveRequest.id===receipt.requestId&&liveRequest.sessionId===receipt.sessionId&&liveRequest.phase==='blocked';
                    if(receipt.result!=="blocked"&&!originalSubmissionBlocked)throw Error("仅允许显式恢复blocked原请求，禁止重复运行");
                    if(!sessions.some(s=>s.pageId===command.pageId&&s.id===command.sessionId&&JSON.stringify(s.queue)===receipt.queueJson))throw Error("原会话内容已变化");
                    await controller.resume({...command,allowPreparationRepair:command.action==='resume_preparation'});
                    receipt.result="submitting";receipt.error=undefined;await save();await status(receipt);
                    await response({state:"accepted",note:"只恢复原会话未提交项；accepted不代表GPU已接单，请核对promptId"});
                  }
                }catch(error){await response({state:"blocked",error:error instanceof Error?error.message:String(error)});}
              }
            }
            for (const r of Object.values(state.queues)) {
              if(r.userHeld){await status(r,{submissionHeld:true,blockingNewQueues:false,note:'用户明确停止的旧批次保留；根开关/STOP恢复不会重启该批次，原产物保留'});continue;}
              if(r.result==='superseded'){await status(r,{submissionHeld:true,blockingNewQueues:false,note:'原队列源文件已被移除、改名或替换，已退出自动调度；不会提交该旧版本，原记录与产物保留'});continue;}
              if(r.result==="blocked"&&r.pageId&&r.sessionId&&!r.saveDiagnosticAt){
                const controller=readInboxRecovery(r.pageId);
                if(controller){
                  let diagnostic:unknown;
                  try{diagnostic=await controller.diagnose(r.sessionId);}catch(error){diagnostic={error:error instanceof Error?error.message:String(error)};}
                  await write(project,r.file.replace(/\.json$/i,"_save_diagnostic_status.json"),diagnostic);
                  r.saveDiagnosticAt=new Date().toISOString();await save();
                }
              }
              // Legacy 'submitted' meant handoff only. Audit instead of replaying it.
              if (r.result === "submitted" || (r.result === "cleared" && r.file === "EP01_R3_test_S01-S08_queue.json")) {
                if (!r.queueJson) {
                  try { const data=await json<unknown>({op:"file",project,name:r.file}); resolveNames(data,map); r.queueJson=JSON.stringify(parseShotQueue(JSON.stringify(data))); } catch { /* invalid legacy data remains blocked */ }
                }
                const match = sessions.filter(s => JSON.stringify(s.queue) === r.queueJson);
                if (match.length === 1) {
                  r.pageId=match[0].pageId; r.sessionId=match[0].id; r.result="session_created";
                } else {
                  let prompts:string[] = [], titles:string[] = [];
                  try { const q=JSON.parse(r.queueJson ?? "{}"); const shots=q.chapters.flatMap((c:{shots:{prompt:string;title:string}[]})=>c.shots); prompts=shots.map((s:{prompt:string})=>s.prompt); titles=shots.map((s:{title:string})=>s.title); } catch { /* invalid receipt remains blocked */ }
                  const nodes = editor.getPages().flatMap(p => [...editor.getPageShapeIds(p.id)].map(id=>editor.getShape(id)).filter(Boolean).filter(s => {
                    const props=s!.props as {prompt?:string;shotTitle?:string;name?:string};
                    return (props.prompt && prompts.includes(props.prompt)) || titles.includes(props.shotTitle ?? props.name ?? "");
                  }).map(s=>({pageId:p.id,nodeId:s!.id})));
                  const matchedRuns=runs.filter(run => nodes.some(n=>n.nodeId===run.ownerNodeId) || (!!run.rawPrompt && prompts.includes(run.rawPrompt)));
                  r.audit={checkedAt:new Date().toISOString(),sessions:match.map(s=>s.id),nodes,runs:matchedRuns.map(run=>({runId:run.runId,ownerNodeId:run.ownerNodeId,promptId:run.comfyPromptId,status:run.status,submission:run.submission}))};
                  r.result="blocked"; r.error="旧交接没有唯一匹配会话；已保留现场审计，需核对history，禁止自动重提";
                }
                await save(); await status(r,{audit:r.audit});
              }
              const legacyHandoffTimeout=r.result==='blocked'&&!r.sessionId&&r.error==='90秒未收到目标页会话确认；不自动重提，请核对角色准备、Run及任务历史';
              if (!ACTIVE.has(r.result) && !legacyHandoffTimeout && !(r.sessionId && ['completed','finished_with_errors','blocked','stopped'].includes(r.result))) continue;
              const ack=readInboxRequest();
              if (ack && ack.id===r.requestId && ack.phase==="blocked" && !r.sessionId && !legacyHandoffTimeout) { r.result="blocked"; r.error=ack.error; r.sessionId=ack.sessionId ?? r.sessionId; await save(); await status(r); continue; }
              if (ack && ack.id===r.requestId && ack.sessionId) { r.sessionId=ack.sessionId; r.result=ack.phase; }
              if(!r.sessionId&&(r.result==='awaiting_session'||legacyHandoffTimeout)){
                const rows=await getCleanupMetadata();const matches=rows.filter(row=>/^shot-queue-(session|file-v2)/.test(row.key)).map(row=>row.value as QueueSession).filter(s=>s?.pageId===r.pageId&&JSON.stringify(s.queue)===r.queueJson);
                const unique=[...new Map(matches.map(s=>[s.id,s])).values()];if(unique.length===1){r.sessionId=unique[0].id;r.result='session_created';r.error=undefined;}
              }
              const session=sessions.find(s => s.pageId===r.pageId && s.id===r.sessionId);
              let observed=session;
              if(!observed&&r.sessionId){
                const rows=await getCleanupMetadata();
                const rank=(key:string)=>key.startsWith('shot-queue-file-v2:')?0:key.startsWith('shot-queue-session-archive-v1:')?1:2;
                observed=rows.filter(row=>/^shot-queue-(file-v2:|session-archive-v1:|session-v1:)/.test(row.key)).sort((a,b)=>rank(a.key)-rank(b.key)).map(row=>row.value as QueueSession).find(s=>s?.version===1&&s.id===r.sessionId&&s.pageId===r.pageId&&Array.isArray(s.entries));
              }
              if (!observed) {
                if(['completed','finished_with_errors'].includes(r.result)){
                  await status(r,{sessionObservation:'原会话已不在当前页槽位；保留原终态与缓存产物，不凭缺少会话重新判为失败，也不重新提交',pageSlotDisplaced:false});continue;
                }
                if (inboxHandoffExpired(r.at)) {
                  // Keep observing the same request. Never poison its live ack
                  // or create/re-submit nodes just because timers were throttled.
                  if(r.sessionId){r.result='blocked';r.error='原会话暂不可核实；保留原sessionId，不创建替代会话或重提任务';}
                  else if(!legacyHandoffTimeout){r.result='awaiting_session';r.error=undefined;}
                  await status(r,{confirmationPending:true,pageSlotDisplaced:false,note:'尚未确认目标页会话；后台/锁屏不视为失败。心跳或页面恢复后自动核对原会话，不自动重新提交。'});continue;
                }
                await save(); await status(r); continue;
              }
              const displaced=!session;
              const progress=inboxProgress(observed,runs,assetList ??= await listAllAssets());
              // Observation may repair a stale status, but never releases a blocked submit controller.
              r.result=r.result==='blocked'&&!['completed','finished_with_errors','running'].includes(progress.state)?'blocked':progress.state;
              if(progress.error)r.error=progress.error;else if(r.result!=='blocked')r.error=undefined;
              await status(r,{...progress,pageSlotDisplaced:displaced,confirmationPending:false,...(displaced?{note:'原会话在文件库，页槽由其他批次占用；已核对到既有会话与 Run，不重新交接、不切换页槽。'}:{})});
            }
            const blocks=(hash:string,r:Receipt)=>inboxReceiptBlocks(r,files.some(f=>f.name===r.file&&f.sha256===(r.contentHash??hash)),rolloutProtectsQueue(rollout,r.contentHash??hash),sessions,runs);
            for(const [hash,r] of Object.entries(state.queues))if(r.result==='blocked'&&!blocks(hash,r)){
              await status(r,{blockingNewQueues:false,submissionHeld:true,note:'历史阻塞批次的源文件已不在或受上线保护，且未发现活动/不明任务；保留原状态及产物，不恢复旧批次，不再阻塞新队列'});
            }
            const blocker=Object.entries(state.queues).find(([hash,r])=>blocks(hash,r))?.[1] ?? otherActive.find(other=>other.project!==project)?.receipt;
            for (const [hash,r] of Object.entries(state.queues).filter(([,r])=>["received","waiting","missing_assets"].includes(r.result))) {
              // A filename can be overwritten while waiting. Never dispatch its new contents under an old receipt.
              if (!files.some(f=>f.name===r.file && f.sha256===(r.contentHash??hash))) { r.result="superseded";await status(r,{submissionHeld:true,blockingNewQueues:false,note:'原队列源文件已被移除、改名或替换，已退出自动调度；不会提交该旧版本，原记录与产物保留'});continue; }
              if(r.validateOnly){
                const source=await json<PageHint>({op:'file',project,name:r.file});
                const target=inboxTargetPage(editor,source);
                if(target.pageId&&editor.getCurrentPageId()!==target.pageId&&source.autoSwitchPage===true)await switchInboxPage(editor,target.pageId);
                const pageId=target.pageId;r.pageId=pageId??undefined;
                if(!pageId||editor.getCurrentPageId()!==pageId){await status(r,{note:pageId?`干跑等待目标页「${target.label}」；不提交 GPU。`:`找不到队列指定的目标页「${target.label}」，本轮不入队。`});continue;}
                try{
                  const data=await json<unknown>({op:'file',project,name:r.file});
                  if(data&&typeof data==='object'&&!Array.isArray(data))delete (data as {cardsOnly?:unknown}).cardsOnly;
                  const report=validateInboxQueue(data,map,await listAssets(),await listRoles(),true);
                  r.result=report.ok?'validated':'rejected';r.error=report.ok?undefined:report.errors.join('\n');
                  const {queue:_validatedQueue,...validation}=report;
                  // 镜头卡片的 15 项检查（写错 / 漏写），写进状态文件给投放的 AI 读；只提示，不拦截。
                  let cardChecks:unknown=null;try{if(report.queue)cardChecks=queueCardReport(report.queue,await listRoles(),await listAssets());}catch{/* checks are advisory */}
                  await status(r,{validation,cardChecks,note:'仅解析、资产及提示词编译校验；未创建节点，未触发GPU。动态首尾帧在来源完成后验证。'});
                  const output=await fetch('/__inbox/artifacts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project,source:r.file,validation})});if(!output.ok)throw Error('逐镜编译报告写入失败');
                  if(r.cardsOnly){
                    // The resolved queue (asset names → IDs) when it parsed; otherwise the raw file, so the cards can show what is wrong.
                    const text=`${JSON.stringify(report.queue ?? data,null,2)}\n`;
                    const answer=await new Promise<string|null>(resolve=>{let done=false;const reply=(problem:string|null)=>{if(!done){done=true;resolve(problem);}};window.dispatchEvent(new CustomEvent('frameflow-inbox-cards',{detail:{text,file:r.file,reply}}));window.setTimeout(()=>reply('画布的队列面板还没准备好'),4000);});
                    if(answer){r.result='waiting';r.error=undefined;await status(r,{note:`等放进镜头卡片：${answer}；不提交 GPU。`});continue;}
                    r.result='loaded_to_cards';await status(r,{note:'已放进画布的镜头卡片，等你检查、修改后自己点入队；没有提交 GPU。'});
                  }
                }catch(error){r.result='rejected';r.error=error instanceof Error?error.message:String(error);await status(r);}
                continue;
              }
              if(r.userHeld||control?.heldQueueHashes?.includes(r.contentHash??hash)){
                r.userHeld=true;r.result='stopped';await status(r,{submissionHeld:true,blockingNewQueues:false,note:'用户明确停止的旧批次保留；根总控打开不会重新提交'});continue;
              }
              if(rolloutProtectsQueue(rollout,r.contentHash??hash)){
                await status(r,{submissionHeld:true,note:'上线前队列保留，仅更新状态；不会自动启动、恢复或重试。需要用户明确原会话操作。'});continue;
              }
              const root=readInboxRootSnapshot();
              if(!root.effective.autoEnqueue||!root.effective.submit){r.result='waiting';await status(r,{note:root.stop?'根目录STOP生效：暂停自动入队，未提交GPU':root.error??'根总控等待：autoEnqueue / submit 未全部开启；干跑校验不受影响'});continue;}
              if(existingReceipts.some(p=>p.unreadable)){r.result='waiting';await status(r,{note:'收件箱存在损坏的历史记录；只处理已登记会话与明确恢复命令，禁止把旧文件当作全新任务导入'});continue;}
              if (control?.paused || blocker) { r.result="waiting"; await status(r,{note:control?.paused ? control.reason ?? "用户暂停收件箱自动提交" : `等待处理前批：${blocker!.file}`}); continue; }
              const source=await json<PageHint>({op:'file',project,name:r.file});
              const target=inboxTargetPage(editor,source);
              if(target.pageId&&editor.getCurrentPageId()!==target.pageId&&source.autoSwitchPage===true)await switchInboxPage(editor,target.pageId);
              const pageId=target.pageId;
              if (!pageId || editor.getCurrentPageId()!==pageId) { await status(r,{note:pageId?`请切换到目标页「${target.label}」后再入队。`:`找不到队列指定的目标页「${target.label}」，本轮不入队。`}); continue; }
              const slot=sessions.find(s=>s.pageId===pageId);
              if(slot&&pageSlotHasWork(slot,runs)){await status(r,{note:`目标页正由会话 ${slot.id} 继续。本批排在该页槽之后；不切换页槽、不新建会话、不提交。`});continue;}
              let parsed;
              try {
                const data=await json<unknown>({op:"file",project,name:r.file});
                const report=validateInboxQueue(data,map,await listAssets(),await listRoles());
                const {queue:_validatedQueue,...validation}=report;
                r.details={...r.details,validation};
                try{if(report.queue)r.details={...r.details,cardChecks:queueCardReport(report.queue,await listRoles(),await listAssets())};}catch{/* checks are advisory, never block a render */}
                if(!report.ok||!report.queue){r.result='rejected';r.error=report.errors.join('\n');await status(r);continue;}
                // 画面五项·必写：有一镜漏写就整批不提交，原因写进 _status.json（cardChecks.gate 里有逐镜清单）。先跑正本 h3q，以它的 [五项·…] ERROR 为准，没跑成用画布兜底（原因里写明）；文件里的确认字段不读，只认用户在卡片里亲手确认过的（画布 store）。
                {const gate=await checkQueueGate(report.queue);if(r.details?.cardChecks)r.details={...r.details,cardChecks:{...(r.details.cardChecks as object),gate:{ok:gate.ok,message:gate.message,source:gate.source,failures:gate.failures.map(f=>({title:f.title,missing:f.items.map(i=>i.label)}))}}};if(!gate.ok){r.result='rejected';r.error=gate.message;await status(r);continue;}}
                parsed=report.queue;
              } catch(error) { r.result="rejected";r.error=error instanceof Error?error.message:String(error);await save();await status(r);continue; }
              const canonical=JSON.stringify(parsed);
              const duplicate=Object.values(state.queues).find(other=>other!==r && !other.validateOnly && other.queueJson===canonical);
              if (duplicate) { r.result="skipped";await status(r,{duplicateOf:duplicate.file,originalResult:duplicate.result,note:`相同队列已 ${duplicate.result}，不重复提交`});continue; }
              r.result="preparing";r.pageId=pageId;r.requestId??=crypto.randomUUID();r.queueJson=canonical;r.at=new Date().toISOString();
              // The durable preparing receipt is written before the sole handoff. Reload only observes it.
              await save(); await status(r);
              beginInboxRequest({id:r.requestId,pageId,queueJson:r.queueJson,phase:"preparing"});
              const host=window as Window & {__ffShotQueueBoot?:unknown;__ffShotQueueRun?:boolean};
              delete host.__ffShotQueueBoot; host.__ffShotQueueRun=false;
              if (!stopped) live.current.onQueue(JSON.stringify(parsed,null,2),r.requestId);
              return;
            }
          }
        });
      } catch(error) { console.warn("[inbox scheduler]",error); }
      finally { busy=false; }
    };
    const wake=()=>{void tick();};
    const timer=setInterval(wake,4000);window.addEventListener?.('focus',wake);window.addEventListener?.('pageshow',wake);globalThis.document?.addEventListener('visibilitychange',wake);void tick();
    // Other pages stay in the tldraw document (its writer deletes any record removed from the store).
    // This tick does not resolve their blobs, mount their nodes, or keep the asset catalogue after it returns.
    return ()=>{stopped=true;clearInterval(timer);window.removeEventListener?.('focus',wake);window.removeEventListener?.('pageshow',wake);globalThis.document?.removeEventListener('visibilitychange',wake);};
  },[editor,placeImages,resolveNames]);
}
