"use client";
import {useEffect} from 'react';
import type {Editor} from 'tldraw';
import {refreshInboxRootControl} from '@/lib/inbox-root-control';
import {getMeta,patchMeta,listRuns,listAllAssets} from '@/lib/production-records';
import {applyRootSessionStop} from '@/lib/inbox-session-stop';
import {queueSessionKey,latestQueueRun,type QueueSession} from '@/lib/shot-queue-session';
import {inboxProgress} from '@/lib/inbox-queue-report';
import {submissionSchedulerStatus} from '@/lib/comfyui/submission-scheduler';
import {createInboxFileService} from '@/lib/inbox-file-service';
import {inboxControlFieldStatus} from '@/lib/inbox-control-field-status';
import {allFileSessions,fileSessionKey} from '@/lib/inbox-session-registry';
import {inboxStateHealth} from '@/lib/inbox-state-health';

/** Poll controls independently of long-running queue preparation. */
export function useInboxRootControl(editor:Editor){
  useEffect(()=>{
    const service=createInboxFileService(editor,'frameflow-v0.1-canvas');
    let stopped=false,polling=false;
    const poll=async()=>{
      if(stopped||polling)return;polling=true;
      try{
        // 每个标签页都刷轻量总控开关，保证本页及时收到 stopSessions / pauseSessions
        const control=await refreshInboxRootControl();
        if(stopped)return;
        const runSummary=async()=>{
          if(stopped)return;
          let snapshot:Record<string,unknown>={currentBatch:null,remainingShots:null,batches:[],errors:[]};
          try{
          const [runs,assets,sessions]=await Promise.all([listRuns(),listAllAssets(),allFileSessions()]);
          for(let index=0;index<sessions.length;index++){
            const session=sessions[index];if(!session||!control.stopSessions?.includes(session.id))continue;
            const durable=await patchMeta<QueueSession>(fileSessionKey(session.id),fresh=>{const next=fresh??session;applyRootSessionStop(next,control.stopSessions??[]);return next;});if(durable)sessions[index]=durable;
            await patchMeta<QueueSession>(queueSessionKey(session.pageId),fresh=>{if(fresh?.id===session.id)applyRootSessionStop(fresh,control.stopSessions??[]);return fresh;});
          }
          const comfy=await fetch('/comfyui/queue',{cache:'no-store',signal:AbortSignal.timeout(3000)}).then(async response=>{if(!response.ok)throw Error(`HTTP ${response.status}`);return await response.json() as {queue_running:[number,string,...unknown[]][];queue_pending:[number,string,...unknown[]][]};}).catch(()=>null);
          const batches=sessions.filter((s):s is QueueSession=>!!s).map(s=>{
            const progress=inboxProgress(s,runs,assets);
            const prompts=new Set(runs.filter(run=>s.entries.some(entry=>entry.nodeId===run.ownerNodeId)).map(run=>run.comfyPromptId));
            for(const entry of s.entries)for(const frame of [entry.frameInputs?.first,entry.frameInputs?.last])if(frame?.enhancement?.promptId)prompts.add(frame.enhancement.promptId);
            return {sessionId:s.id,pageId:s.pageId,title:s.queue.title,state:progress.state,total:progress.total,completed:progress.completed,remaining:progress.shots.filter(shot=>!['completed','cancelled'].includes(shot.state)).length,stopped:!!s.stoppedAt||s.autoContinueFrames!==true,stoppedAt:s.stoppedAt??null,stopSource:s.stopSource??null,stopReason:s.stopReason??(s.stoppedAt?'用户手动停止':s.autoContinueFrames!==true?'此会话未授权自动续接':null),stopRequested:control.stopSessions?.includes(s.id)??false,counts:progress.counts,execution:s.entries.filter(e=>e.execution).map(e=>({nodeId:e.nodeId,...e.execution,...(latestQueueRun(e,runs)?.status==='completed'?{phase:'completed',leaseUntil:0}:{} )})),comfyRunning:comfy?.queue_running.filter(job=>prompts.has(job[1])).length??null,comfyPending:comfy?.queue_pending.filter(job=>prompts.has(job[1])).length??null};
          });
          for(const batch of batches)Object.assign(batch,{paused:control.pauseSessions?.includes(batch.sessionId)??false,pauseReason:control.pauseSessions?.includes(batch.sessionId)?'用户通过pauseSessions暂停，可移除后恢复':null,priority:control.priority?.indexOf(batch.sessionId)??-1});
          const currentBatch=batches.find(b=>(b.comfyRunning??0)>0)??batches.find(b=>(b.comfyPending??0)>0)??null;
          void service.tick(sessions.filter((s):s is QueueSession=>!!s),runs,assets,control);
          snapshot={currentBatch,remainingShots:currentBatch?.remaining??0,batches,waitingBatches:batches.filter(b=>!b.stopped&&b.remaining>0),comfy:comfy?{available:true,running:comfy.queue_running.length,pending:comfy.queue_pending.length}:{available:false,error:'ComfyUI队列未核实，不凭旧Run声称正在运行'},errors:[]};
          }catch(error){snapshot.errors=[error instanceof Error?error.message:String(error)];}
          const serviceState=service.status();
          const executionErrors=Object.entries(serviceState.effects).flatMap(([key,value])=>{const item=value as {state?:string;error?:string;message?:string};return item&&(item.error||item.state==='offline')?[key+': '+(item.error??item.message??item.state)]:[];});
          const receiptHealth=inboxStateHealth();snapshot.inboxReceipts=receiptHealth;
          snapshot.errors=[...(snapshot.errors as string[]??[]),...executionErrors,...receiptHealth.filter(p=>p.state==='corrupt_or_unreadable').map(p=>p.project+': 状态记录损坏/不可读取，已隔离，不覆盖、不自动重建')];
          snapshot.health={heartbeat:'fresh',scan:{...serviceState.observation,result:serviceState.effects.inbox??null},executor:serviceState.diagnostic,preparation:(snapshot.batches as {sessionId:string;execution:unknown[]}[]??[]).flatMap(batch=>batch.execution.map(execution=>({sessionId:batch.sessionId,...execution as object}))),post:submissionSchedulerStatus()};
          const fields=inboxControlFieldStatus(control,(snapshot.batches??[]) as {sessionId:string;stopped:boolean;comfyPending:number|null}[],service.status().effects);
          const response=await fetch('/__inbox/control-status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...snapshot,fields,fileOperations:service.status(),localSubmissions:submissionSchedulerStatus(),canvasObservedAt:new Date().toISOString()}),signal:AbortSignal.timeout(3500)});
          if(!response.ok)throw Error(`总控状态写入失败 HTTP ${response.status}`);
        };
        // 全表汇总与状态上报加跨标签 ifAvailable 锁，多开标签页时仅一个标签页执行
        if(typeof navigator!=='undefined'&&navigator.locks){
          await navigator.locks.request('frameflow-inbox-root-control-summary-v1',{ifAvailable:true},async lock=>{
            if(!lock)return;
            await runSummary();
          });
        }else{
          await runSummary();
        }
      }catch(error){console.warn('[inbox root control]',error);}finally{polling=false;}
    };
    void poll();const timer=setInterval(()=>void poll(),4000);
    return()=>{stopped=true;clearInterval(timer);};
  },[editor]);
}
