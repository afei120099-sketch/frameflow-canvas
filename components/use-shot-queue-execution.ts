"use client";

import {recoverTailOutput} from '@/lib/tail-frame-output-recovery';
import {retireInvalidHeldTail,retiredHeldAllows} from '@/lib/held-tail-recovery';
import {auditQueueFrame} from '@/lib/tail-frame-integrity-audit';
import {bounded,boundedLock,type OperationScope} from '@/lib/operation-scope';
import {saveSessionDelta} from '@/lib/queue-session-store';
import {entryDue,adoptSessionSnapshot,type EntryPhase} from '@/lib/queue-entry-state';
import { useEffect, useRef, useState } from "react";
import { useValue, type Editor, type TLShape } from "tldraw";
import { beginInboxRequest, matchingInboxRequest, reportInboxRequest, registerInboxRecovery, type InboxResumeTarget, type InboxVoiceNoneTarget } from "@/lib/inbox-queue-protocol";
import { planInboxResume } from "@/lib/inbox-resume-plan";
import { missingPrimaryVoice } from '@/lib/queue-voice-validation';
import { diagnoseCanvasRecords } from "@/lib/canvas-save-status";
import {PreparationUnavailableError} from '@/lib/comfyui/preparation-connection';
import {legacyPreparationNotSentCandidate,provenPreparationNotSent} from '@/lib/preparation-not-sent';
import { waitForCanvasSave } from "@/lib/canvas-library";
import { readH3Automation } from "@/lib/canvas-automation";
import { getAsset, getMeta, listRuns, putMeta, updateRun, RUN_CHANGE_CHANNEL } from "@/lib/production-records";
import { fetchZhengbenVersion } from "@/lib/zhengben-client";
import { listRoles } from "@/lib/role-records";
import { planShotReferences, shotQueueH3Props, type ShotQueue } from "@/lib/shot-queue";
import { comfyUIH3Adapter } from "@/lib/comfyui/h3-adapter";
import { withLock, saveNodeForRun } from "@/lib/run-recovery";
import { latestQueueRun, maySubmitQueueEntry, queueEntryUncertain, newQueueSession, queueNodePosition, queueRowKey, queueSessionKey, healPowerLossQueueEntries, type QueueSession } from "@/lib/shot-queue-session";
import { classifyQueueSubmissionError, QueuePersistenceError } from "@/lib/queue-submission-policy";
import { getLocalVideoBlob, extractVideoFrameAt, extractVideoFirstFrame } from "@/lib/local-video-store";
import { SubmissionUncertainError } from "@/lib/ai-adapter";
import { queueFramePlan, queueFrameDescription, assertQueueFrameRemoval, QueueFrameWaitingError, resolveQueueFrameInputs, frameEntriesToResume, hasQueueFrameSources } from '@/lib/shot-queue-frames';
import {enhanceQueueTailFrame,storeQueueFrame} from '@/lib/queue-tail-frame-enhance';
import {registerQueueRemovalCancel} from '@/lib/node-task-activity';
import {createQueueFrameRunObserver} from '@/lib/queue-frame-run-observer';
import {prepareInboxShotRetry,cancelInboxShot} from '@/lib/inbox-shot-actions';
import type {InboxShotTarget} from '@/lib/inbox-queue-protocol';
import {waitForInboxRootControl,assertInboxSessionActive,subscribeInboxRootControl,readInboxRootSnapshot} from '@/lib/inbox-root-control';
import {shotFileDisposition,prepareFileRerun,type ShotSelector} from '@/lib/inbox-file-policy';
import {releaseSettledSourceContinuations,rerunProbeAllows} from '@/lib/comfy-lost-verdict';
import {rememberFileSession} from '@/lib/inbox-session-registry';
import {getSnapshot} from 'tldraw';
import { findReusableShots, planBatchStart, type BatchStartPlan } from '@/lib/shot-queue-batch-plan';
import { checkQueueGate } from '@/components/gate-check';
import { abortable, waitUntil, describeStop, STOP_EXIT_MS, FORCE_UNLOCK_NOTE, type StopShotState } from '@/lib/queue-stop';

type CreateProps = ReturnType<typeof shotQueueH3Props>;
type Row = { status: "pending" | "submitting" | "queued" | "running" | "completed" | "failed" | "stopped" | "unconfirmed"; detail: string; nodeId?: string };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function useShotQueueExecution({ editor, queue, restore, message, createNode, focusNode, origin, persistenceKey, drawerOpen = true }: {
  editor: Editor; queue: ShotQueue | null; persistenceKey: string; drawerOpen?: boolean;
  restore: (queue: ShotQueue) => boolean | void; message: (text: string) => void;
  createNode: (props: CreateProps, point: { x: number; y: number },signal?:AbortSignal) => Promise<{ id: string } | undefined>;
  focusNode: (id: string, moveCamera?: boolean) => void; origin: () => { x: number; y: number };
}) {
  const pageId = useValue("shot queue page", () => editor.getCurrentPageId(), [editor]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [busyChapter, setBusyChapter] = useState<number | null>(null);
  const [loadedPage, setLoadedPage] = useState("");
  const ready = loadedPage === pageId;
  const [runningAll, setRunningAll] = useState(false);
  // 停止后续排队：stopping = 正在停；stuck = 循环几秒内没退出，界面给「强制解锁」；stoppedAt = 本批停过（卡片不再等 ComfyUI 里剩下的镜头）。
  const [stopping, setStopping] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  const session = useRef<QueueSession | null>(null);
  const persisted = useRef(new Map<string,QueueSession>());
  const pageBefore = useRef<string|null>(null);
  const loadSession = async()=>{const saved=await getMeta<QueueSession>(queueSessionKey(pageId));pageBefore.current=saved?.id??null;if(saved)persisted.current.set(saved.id,structuredClone(saved));return saved;};
  const queueRef = useRef(queue);
  const stopRef = useRef<AbortController | null>(null);
  // null means a pre-update submit is still inside its closure. 'active' is this module's own submit.
  const submitPhase = useRef<string | null>(null);
  const userStop = useRef(false);
  // 同标签页提交串行尾链、手动双击防重、停止代次（用于取消排队中的同页二次提交）
  const sameTabTail = useRef<Promise<void>>(Promise.resolve());
  const manualSubmitActive = useRef(false);
  const stopEpoch = useRef(0);
  const callbacks = useRef({ restore, message });
  useEffect(() => { callbacks.current = { restore, message }; queueRef.current = queue; });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopRef.current?.abort(); }; }, []);
  useEffect(() => {
    let active = true;
    session.current = null;
    void loadSession().then(async saved => {
      if (!active) return;
      setRows({});
      if (saved?.version === 1 && saved.pageId === pageId) {
        session.current = saved;
        const restored = callbacks.current.restore(saved.queue);
        const pendingFrames = frameEntriesToResume(saved, await listRuns());
        if (!active) return;
        callbacks.current.message(pendingFrames.length
          ? `已恢复本画布的镜头队列。${pendingFrames.length} 个续段尚未提交，将自动等待来源完成并截帧入队；已提交的镜头不会重提。`
          : saved.autoContinueFrames!==true || saved.stoppedAt ? "原队列已保留为只读恢复；旧会话或已停止批次不会自动接帧、提交或重试。需要时由用户明确点击继续未完成。" : restored === false ? "原队列会话已读取，保留当前编辑的文本。请先检查镜头表；已提交的任务仍在原节点查询，不会自动重提。" : "已恢复本画布的镜头队列。已提交的任务只查询，不会自动重复提交；未提交或明确失败的可继续入队。");
        setLoadedPage(pageId);
        if (pendingFrames.length) void submit(undefined, false, true);
        return;
      }
      setLoadedPage(pageId);
    }).catch(() => { if (active) callbacks.current.message("队列记录读取失败，暂不允许提交，避免重复任务"); });
    return () => { active = false; stopRef.current?.abort(); };
  }, [pageId]);

  // Presentation comes from durable Runs, not a promise held by this drawer.
  // 抽屉折叠时轮询从 2s 降到 15s，同时监听 RUN_CHANGE_CHANNEL 广播在 Run 变化时立刻刷新。
  useEffect(() => {
    let active = true;
    let running = false;
    let pendingWake = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollMs = drawerOpen ? 2000 : 15000;
    const tick = async () => {
      if (!active) return;
      if (running) { pendingWake = true; return; }
      running = true;
      clearTimeout(timer);
      try {
        const saved = session.current;
        if (saved && saved.pageId === pageId && JSON.stringify(saved.queue) === JSON.stringify(queueRef.current)) {
          const runs = await listRuns();
          if (active) setStoppedAt(saved.stoppedAt ?? null);
          if (active) setRows(current => {
            const next: Record<string, Row> = {};
            for (const entry of saved.entries) {
              const run = latestQueueRun(entry, runs);
              const key = queueRowKey(entry);
              const liveNodeId = entry.nodeId && editor.getShape(entry.nodeId as TLShape["id"]) ? entry.nodeId : undefined;
              if(entry.removedAt||entry.cancelRequestedAt||entry.cancelledAt){next[key]={status:'stopped',detail:entry.removedAt?'删除请求已关闭本镜自动提交；撤销节点不会重启渲染':entry.cancelledAt?'本镜已取消，不会自动恢复':'本镜取消待确认，保留现场，不会重新提交',...(liveNodeId?{nodeId:liveNodeId}:{})};continue;}
              const baseRow: Row = queueEntryUncertain(entry, runs) ? { status: "unconfirmed", detail: entry.error ?? "提交结果尚未确认，不会自动重提" } : run
                ? { status: run.status === "cancelled" ? "stopped" : run.status === "queued" && run.submission === "reserved" ? "unconfirmed" : run.status, detail: run.error ?? (run.comfyPromptId ? `任务 ${run.comfyPromptId}` : "") }
                : entry.outcome === "uncertain" || entry.submissionState === "started" || entry.submissionState === "accepted" || (entry.nodeId && entry.submissionState === undefined && entry.outcome === undefined)
                  ? { status: "unconfirmed", detail: entry.error ?? "旧记录或提交结果尚未确认，不会自动重提" }
                  : entry.waitingReason ? { status:'pending',detail:entry.waitingReason } : entry.error ? { status: "failed", detail: entry.error } : current[key]?.status === "submitting" ? current[key] : { status: "pending", detail: entry.nodeId ? "节点已保存，待提交" : "待创建节点" };
              next[key] = liveNodeId ? { ...baseRow, nodeId: liveNodeId } : baseRow;
            }
            for(const entry of saved.entries){const row=next[queueRowKey(entry)];if(row&&entry.execution&&!['completed','running','queued','stopped'].includes(row.status)){const ex=entry.execution;row.detail+=` · ${ex.phase} · ${ex.attemptId.slice(0,8)}${ex.nextRetryAt?' · 下次核实 '+new Date(ex.nextRetryAt).toLocaleTimeString():''}`;}}
            return next;
          });
        }
      } catch { /* A transient local DB error must never submit or reset tasks. */ }
      finally {
        running = false;
        if (active) {
          if (pendingWake) { pendingWake = false; timer = setTimeout(() => void tick(), 120); }
          else timer = setTimeout(() => void tick(), pollMs);
        }
      }
    };
    const wake = () => { if (active) void tick(); };
    const channelName = typeof RUN_CHANGE_CHANNEL === "string" ? RUN_CHANGE_CHANNEL : "frameflow-run-changes";
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;
    channel?.addEventListener("message", wake);
    if (typeof window !== "undefined") window.addEventListener(channelName, wake);
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
      channel?.close();
      if (typeof window !== "undefined") window.removeEventListener(channelName, wake);
    };
  }, [pageId, ready, drawerOpen]);

  const persist = async (saved: QueueSession, signal?:AbortSignal,activate=false,explicitResume=false) => {
    signal?.throwIfAborted();
    try{assertInboxSessionActive(saved.id);}catch{saved.autoContinueFrames=false;saved.stoppedAt??=Date.now();saved.stopSource='root_stopSessions';saved.stopReason='用户通过_control.json stopSessions停止本批';}
    try {
      const before=persisted.current.get(saved.id)??null;
      const merged=await saveSessionDelta(saved,before,{signal,activate:activate||!before,expectedPageId:pageBefore.current,explicitResume});
      signal?.throwIfAborted();adoptSessionSnapshot(saved,merged);
      persisted.current.set(saved.id,structuredClone(merged));session.current=saved;pageBefore.current=saved.id;
    }catch(cause){throw new QueuePersistenceError(cause);}
  };
  useEffect(()=>subscribeInboxRootControl(control=>{
    const saved=session.current;if(!saved||!control.stopSessions?.includes(saved.id))return;
    // Abort only queue preparation. Do not call stopWaiting: already accepted GPU jobs must finish.
    if(JSON.stringify(saved.queue)===JSON.stringify(queueRef.current))stopRef.current?.abort();
    saved.autoContinueFrames=false;saved.stoppedAt??=Date.now();saved.stopSource='root_stopSessions';saved.stopReason='用户通过_control.json stopSessions停止本批';
    // The independent root poll transactionally patches the latest durable record.
  }),[pageId]);
  useEffect(()=>registerQueueRemovalCancel(pageId,async ids=>{
    const matches=(batch:QueueSession|null)=>batch?.entries.some(entry=>entry.nodeId&&ids.includes(entry.nodeId));
    // Abort the local submission controller only, not other ComfyUI jobs.
    if(matches(session.current))stopRef.current?.abort();
    const saved=await loadSession();
    if(!saved||!matches(saved))return;
    stopEpoch.current += 1;
    stopRef.current?.abort();
    for(let attempt=0;attempt<150&&stopRef.current;attempt++)await new Promise(resolve=>setTimeout(resolve,200));
    if(stopRef.current)throw Error('队列提交尚未停止，节点保留，避免取消与新提交相互穿插');
    // 等本标签页 submit 闭包彻底退出并释放 Web Lock，避免刚清 stopRef 的微任务竞态
    await Promise.race([sameTabTail.current, new Promise(resolve => setTimeout(resolve, 2000))]);
    const recordRemoval=async()=>{
      const fresh=await loadSession();
      if(!fresh||fresh.id!==saved.id)throw Error('队列会话已变化，未修改其他批次');
      fresh.autoContinueFrames=false;fresh.stoppedAt=Date.now();
      for(const entry of fresh.entries)if(entry.nodeId&&ids.includes(entry.nodeId))entry.removedAt=Date.now();
      await persist(fresh);
    };
    const runningLockName=`frameflow-shot-queue-running:${pageId}`;
    const lockName=`frameflow-shot-queue-submit:${pageId}`;
    if(typeof navigator!=='undefined'&&navigator.locks)await navigator.locks.request(runningLockName,{ifAvailable:true},async runningLock=>{
      if(!runningLock)throw Error('另一个画布页面仍在提交本批任务，请先停止那里的提交；未取消其他任务或删除节点');
      await navigator.locks.request(lockName,{ifAvailable:true},async lock=>{
        if(!lock)throw Error('另一个画布页面仍在提交本批任务，请先停止那里的提交；未取消其他任务或删除节点');
        await recordRemoval();
      });
    });else await withLock(lockName,recordRemoval);
    callbacks.current.message('正在取消所删节点的任务；本批后续提交已暂停，其他已接单任务保留。剩余镜头可继续未完成，已删除镜头不再提交。');
  }),[pageId]);
  const pageQueueNodes = () => editor.getCurrentPageShapes().filter(shape => shape.type === 'h3-node').flatMap(shape => { const p = shape.props as { shotTitle?: string; prompt?: string }; return p.shotTitle ? [{ nodeId: shape.id as string, title: p.shotTitle, prompt: p.prompt ?? '' }] : []; });
  const stopWaiting = async (saved: QueueSession) => {
    const runs = await listRuns();
    const owned = saved.entries.map(entry => latestQueueRun(entry, runs)).filter(run => run && (run.status === "queued" || run.status === "running"));
    const deleted = await comfyUIH3Adapter.cancelPendingJobs(owned.flatMap(run => run?.comfyPromptId ? [run.comfyPromptId] : []));
    for (const run of owned) {
      if (!run?.comfyPromptId || !deleted.includes(run.comfyPromptId)) continue;
      // A waiting job may have started between the read and deletion. Preserve that job.
      const probe = await comfyUIH3Adapter.probeJob(run.comfyPromptId, saveNodeForRun(run));
      if (probe.state === "not_found") await updateRun(run.runId, { status: "cancelled", completedAt: Date.now(), error: "用户停止本批后续排队；正在执行的任务保留" });
    }
    return deleted;
  };
  const submit = async (chapterIndex?: number, retryOnly = false, framesOnly = false, resumeTarget?:InboxResumeTarget, retryTarget?:InboxShotTarget,fileControlled=false, explicitResume=false, reuse?: 'skip' | 'rerender') => {
    const say = (text: string) => callbacks.current.message(text);
    const isManual = !framesOnly && !resumeTarget && !retryTarget && !fileControlled;
    // 双击「入队」：本标签页已有手动提交在跑（含正在跑 checkQueueGate 尚未设 stopRef 的窗口），第二次直接静默忽略不报错
    if (isManual && manualSubmitActive.current) return;
    if (isManual) manualSubmitActive.current = true;
    const stopEpochAtEntry = stopEpoch.current;
    const entryPage = pageId;
    const previous = sameTabTail.current;
    let releaseTail!: () => void;
    const currentDone = new Promise<void>(resolve => { releaseTail = resolve; });
    sameTabTail.current = currentDone;
    const runExclusive = async () => {
    if (!framesOnly && !queue) { say(retryOnly ? "请先点【检查镜头表】载入当前会话，再点【重试失败镜头】。" : "请先检查镜头表，再入队。"); return; }
    if (!framesOnly && !ready) { say("队列记录还在加载，请稍候再试。"); return; }
    if (!framesOnly && !explicitResume && matchingInboxRequest(pageId, queue)?.phase === "blocked" && !resumeTarget && !retryTarget&&!fileControlled) {
      say(`外部入队请求已暂停：${matchingInboxRequest(pageId, queue)?.error ?? "请先处理阻塞原因"}。不会自动重提。`);
      return;
    }
    // 画面五项·必写：整集 / 本章有一镜不过就整批不提交（lib/shot-gate.ts）。先跑正本 h3q，以它的 [五项·…] ERROR 为准，没跑成用画布兜底；只认用户在卡片里亲手确认、正文没改过的镜头（画布 store，不读队列 JSON）。接着上一批续段（framesOnly / 恢复）不在这里拦。
    if (!framesOnly && queue && !resumeTarget && !explicitResume) {
      const gate = await checkQueueGate(queue, chapterIndex);
      if (!gate.ok) { say(gate.message); if (matchingInboxRequest(pageId, queue)) reportInboxRequest(pageId, queue, "blocked", { error: gate.message }); return; }
    }
    if (!mounted.current || editor.getCurrentPageId() !== entryPage || stopEpoch.current !== stopEpochAtEntry) return;
    const controller = new AbortController();
    stopRef.current = controller; submitPhase.current = 'active'; userStop.current = false;
    setBusyChapter(chapterIndex ?? 0); setRunningAll(chapterIndex === undefined);
    const originalPage = pageId;
    let executionSessionId=session.current&&(framesOnly||JSON.stringify(session.current.queue)===JSON.stringify(queue))?session.current.id:undefined;
    const summary = { submitted: 0, failed: 0, uncertain: 0, skipped: 0, notReached: 0 };
    const retryBlocked: string[] = [];
    const describe = () => {
      const base = `本次已入队 ${summary.submitted} 镜；明确失败 ${summary.failed} 镜；状态不明 ${summary.uncertain} 镜；已完成/已有任务或不满足本次条件 ${summary.skipped} 镜；尚未处理 ${summary.notReached} 镜。`;
      if (!retryOnly || !retryBlocked.length) return base;
      return `${base}失败重试未通过：${retryBlocked.slice(0, 3).join("；")}${retryBlocked.length > 3 ? `等${retryBlocked.length}项` : ""}。`;
    };
    // Loop writes: a stuck local write no longer holds the stop. The write itself still finishes in the background.
    const save = (value: QueueSession) => abortable(persist(value), controller.signal);
    const guard = () => {
      try{assertInboxSessionActive(executionSessionId);}catch(error){controller.abort(error);throw error;}
      if (!mounted.current || editor.getCurrentPageId() !== originalPage) controller.abort();
      controller.signal.throwIfAborted();
    };
    try {
      const prepared = await boundedLock(`frameflow-shot-queue-submit:${pageId}`, async prebuild => {
        const prebuildGuard=()=>{guard();prebuild.check();};
        const persistScoped=(value:QueueSession)=>persist(value,prebuild.signal);
        prebuildGuard();
        const rootKind:'submit'|'automatic'|'chain'=framesOnly?'chain':matchingInboxRequest(pageId,queue)?'automatic':'submit';
        await abortable(waitForInboxRootControl(rootKind,prebuildGuard,say,executionSessionId),prebuild.signal);
        // Re-read under a cross-tab lock: two tabs cannot create duplicate batches.
        let saved = await loadSession();
        if(saved&&(framesOnly||JSON.stringify(saved.queue)===JSON.stringify(queue))){assertInboxSessionActive(saved.id);if(saved.stopSource==='root_stopSessions'&&!explicitResume)throw new DOMException(saved.stopReason,'AbortError');}
        if(retryTarget){
          if(!saved||saved.id!==retryTarget.sessionId||saved.pageId!==retryTarget.pageId||JSON.stringify(saved.queue)!==JSON.stringify(queue))throw Error('失败重试必须匹配原会话，禁止新建节点');
          const node=editor.getShape(retryTarget.nodeId as TLShape['id']);
          const entry=saved.entries.find(e=>e.nodeId===retryTarget.nodeId);
          if(!node||!entry||node.meta.shotQueueSessionId!==saved.id||node.meta.shotQueueEntry!==queueRowKey(entry))throw Error('原节点或会话标记不符');
          await prepareInboxShotRetry(saved,retryTarget.nodeId,await listRuns(),run=>comfyUIH3Adapter.probeJob(run.comfyPromptId!,saveNodeForRun(run)));
          await persistScoped(saved);
        }
        if(resumeTarget && (!saved || saved.id!==resumeTarget.sessionId || saved.pageId!==resumeTarget.pageId || JSON.stringify(saved.queue)!==JSON.stringify(queue)))throw Error("原会话或队列已变化，禁止恢复为新批次");
        if (framesOnly) {
          if (!saved || saved.version !== 1 || saved.pageId !== pageId) return;
          session.current = saved;
        } else if (retryOnly) {
          // Bulk retry must reuse the failed session. Creating a new one wipes outcome=failed and looks like "no reaction".
          if (!saved || saved.version !== 1 || saved.pageId !== pageId) throw Error("没有可重试的原队列会话。");
          if (JSON.stringify(saved.queue) !== JSON.stringify(queue)) throw Error("当前镜头表与原会话不一致（例如改过 JSON 或勾选了禁止背景音乐）。请把镜头表恢复成检查通过时的版本后再点【重试失败镜头】；不会新建节点或重提其他镜头。");
          if (!saved.entries.some(entry => entry.outcome === "failed" && entry.submissionState !== "started" && entry.submissionState !== "accepted" && !entry.removedAt && !entry.cancelledAt && !entry.cancelRequestedAt)) throw Error("原会话里没有可重试的明确失败镜头。");
          session.current = saved;
        } else {
          // An explicit normal submit after deleting ALL old nodes is a new batch,
          // even if the replacement JSON is identical. Never clear tombstones or reuse old entries.
          const allRemoved = saved && JSON.stringify(saved.queue) === JSON.stringify(queue) && saved.entries.length > 0 && saved.entries.every(entry =>
            entry.removedAt && entry.nodeId && !editor.getShape(entry.nodeId as TLShape["id"]));
          if (allRemoved) {
            const runs = await listRuns();
            for (const entry of saved!.entries) {
              const run = latestQueueRun(entry, runs);
              let unresolved = !!run && ["queued", "running"].includes(run.status);
              // No Run record at all: the node never reserved a ComfyUI prompt (Runs are written before /prompt),
              // e.g. a local "项目正在恢复" stop. A deleted node with no Run cannot have a GPU job to wait for.
              if (!unresolved && run && run.status !== "cancelled" && (entry.outcome === "uncertain" || entry.submissionState === "started" || entry.submissionState === "accepted")) {
                const probe = run?.comfyPromptId ? await comfyUIH3Adapter.probeJob(run.comfyPromptId, saveNodeForRun(run)) : null;
                unresolved = !probe || !["completed", "failed"].includes(probe.state);
              }
              if (unresolved) throw Error("旧镜头仍有运行、等待或提交待确认的任务，请先核实原任务；未恢复旧节点，也未提交新批次。");
            }
            await putMeta(`shot-queue-session-archive-v1:${saved!.id}`, saved);
            saved = null;
          }
          if (!saved || JSON.stringify(saved.queue) !== JSON.stringify(queue)) {
          if (saved) await putMeta(`shot-queue-session-archive-v1:${saved.id}`, saved);
          const start = origin();
          const bottom = Math.max(start.y, ...editor.getCurrentPageShapes().map(node => { const box = editor.getShapePageBounds(node); return box ? box.y + box.h + 140 : start.y; }));
          saved = newQueueSession(pageId, queue!, { x: start.x, y: bottom });
          saved.zhengbenVersion = await fetchZhengbenVersion();
          // User chose「跳过」: same title + same prompt nodes on this page that already have a video (or are rendering)
          // become this batch's node for that shot, so nothing is rendered twice. Re-checked here under the submit lock.
          if (reuse === 'skip') {
            const reusable = findReusableShots(queue!, pageQueueNodes(), await listRuns());
            for (const item of reusable) {
              const entry = saved.entries.find(e => e.chapter === item.chapter && e.shot === item.shot);
              if (!entry) continue;
              entry.nodeId = item.nodeId; entry.submissionState = 'accepted'; entry.reusedNode = item.state;
              editor.updateShape({ id: item.nodeId as TLShape['id'], type: 'h3-node', meta: { ...(editor.getShape(item.nodeId as TLShape['id'])?.meta ?? {}), shotQueueSessionId: saved.id, shotQueueEntry: queueRowKey(entry) } });
            }
            if (reusable.length) say(`已认领画布上 ${reusable.length} 个同标题、同提示词的已有节点（已出片 ${reusable.filter(r => r.state === 'done').length}、正在渲染 ${reusable.filter(r => r.state === 'busy').length}），这些镜头不再重出。`);
          }
          await persistScoped(saved);
          } else session.current = saved;
        }
        const batch = saved;
        executionSessionId=batch.id;prebuildGuard();
        if(releaseSettledSourceContinuations(batch,await listRuns()))await persistScoped(batch);
        if(framesOnly && (batch.autoContinueFrames!==true||batch.stoppedAt))return;
        if(explicitResume && !framesOnly && !retryTarget && !retryOnly){
          batch.autoContinueFrames=true;batch.stoppedAt=undefined;batch.stopReason=undefined;batch.stopSource=undefined;
          const healed=await healPowerLossQueueEntries(batch,await listRuns(),{
            probe:run=>comfyUIH3Adapter.probeJob(run.comfyPromptId!,saveNodeForRun(run)),
            failRun:(run,error)=>updateRun(run.runId,{status:'failed',completedAt:Date.now(),error}).then(()=>{}),
          });
          await persist(batch,prebuild.signal,false,true);
          if(batch.stoppedAt||batch.autoContinueFrames!==true){say(batch.stopReason??'本批仍被停止，未恢复接力');return;}
          if(healed)say(`已清理 ${healed} 个断电残留任务，开始继续未完成的镜头…`);
        }else if(!framesOnly && !retryTarget && !retryOnly && (batch.stoppedAt||batch.autoContinueFrames===false)){
          const message='本批已停止或未授权自动续接。再次入队、文件恢复和收件箱交接都不会清掉停止标记。需要时请点击「继续未完成」。';
          reportInboxRequest(originalPage, batch.queue, 'blocked', { sessionId: batch.id, error: message });
          say(message);return;
        }
        const resumeEligible=resumeTarget ? new Set(planInboxResume(batch,await listRuns(),new Map(editor.getCurrentPageShapes().map(shape=>[shape.id,shape])),resumeTarget.allowPreparationRepair)) : null;
        reportInboxRequest(originalPage, batch.queue, "session_created", { sessionId: batch.id });
        const framePlan = batch.queue.chapters.some(c => c.shots.some(s => s.firstFrameFrom || s.lastFrameFrom)) ? queueFramePlan(batch.queue) : undefined;
        const frameIO = framePlan ? { guard, runs:listRuns, asset:getAsset, read:getLocalVideoBlob, pause:async() => {await abortable(waitForInboxRootControl('chain',guard,say,batch.id),controller.signal);await sleep(1000);},
          observeRun:createQueueFrameRunObserver(run=>comfyUIH3Adapter.probeJob(run.comfyPromptId!,saveNodeForRun(run))),
          onWaiting:(text:string)=>callbacks.current.message(text),
          extract:(src:string,edge:'first'|'last') => edge === 'first' ? extractVideoFirstFrame(src) : extractVideoFrameAt(src,Number.MAX_SAFE_INTEGER),
          storeFrame:storeQueueFrame,
          enhanceTail:async(frame:import('@/lib/shot-queue-frames').QueueFrameInput,checkpoint:(frame:import('@/lib/shot-queue-frames').QueueFrameInput)=>Promise<void>)=>{await abortable(waitForInboxRootControl('chain',guard,say,batch.id),controller.signal);return enhanceQueueTailFrame(frame,checkpoint,guard,stage=>callbacks.current.message(stage),batch.id);} } : undefined;
        const roles = await listRoles();
        summary.notReached = batch.entries.filter(entry => chapterIndex === undefined || entry.chapter === chapterIndex).length;
        // Keep full-batch prebuild/global indices. One bad reference must not reject all chapters.
        const plans = await Promise.all(batch.entries.map(async entry => {
          if(retryTarget&&entry.nodeId!==retryTarget.nodeId)return {error:'非本次重试目标，未检查或修改'};
          const shot = batch.queue.chapters[entry.chapter].shots[entry.shot];
          try {
            const ids = [...shot.sceneAssetIds, ...[shot.firstFrameAssetId, shot.lastFrameAssetId].filter((id): id is string => !!id), ...roles.filter(role => shot.roleIds.includes(role.roleId)).flatMap(role => role.primaryAppearanceAssetId ? [role.primaryAppearanceAssetId] : [])];
            const assets = await Promise.all(ids.map(id => getAsset(id)));
            for (const id of [shot.firstFrameAssetId, shot.lastFrameAssetId].filter((id): id is string => !!id)) {
              const asset = await getAsset(id);
              if (!asset || asset.recycled || asset.kind !== "image") throw Error("首尾帧图片缺失或已回收：" + id);
            }
            return { plan: planShotReferences(shot, roles, new Map(assets.filter(asset => asset !== null && !asset.recycled).map(asset => [asset!.assetId, asset!]))) };
          } catch (cause) { return { error: cause instanceof Error ? cause.message : "素材校验失败" }; }
        }));
        if (!framesOnly) callbacks.current.message("正在创建全部镜头节点：按章分行排列（每行最多 10 个，章间空一行）。随后依次提交至 ComfyUI。");
        for (let index = 0; index < batch.entries.length; index++) {
          prebuildGuard();
          const entry = batch.entries[index];
          if(entry.removedAt||entry.cancelRequestedAt||entry.cancelledAt||(retryTarget&&entry.nodeId!==retryTarget.nodeId))continue;
          const prepared = plans[index];
          if (!prepared.plan) {
            if (maySubmitQueueEntry(entry, await listRuns())) { entry.error = `素材校验失败：${prepared.error}`; entry.outcome = "failed"; await persistScoped(batch); }
            continue; // Bad references get an explicit row, not a fabricated empty-reference node.
          }
          if (entry.nodeId) {
            if (!editor.getShape(entry.nodeId as TLShape["id"])) {
              if (framesOnly) continue;
              // The user deleted this node (possibly without the removal hook recording it). Treat it like a
              // recorded deletion: never rebuild or resubmit it, and do not let it block the remaining shots.
              entry.removedAt = Date.now(); await persistScoped(batch);
              const title = batch.queue.chapters[entry.chapter]?.shots[entry.shot]?.title ?? queueRowKey(entry);
              say(`「${title}」的节点已从画布删除：本镜不再提交，继续处理其余镜头。`);
              continue;
            }
            continue;
          }
          if (framesOnly) continue;
          // Recover a shape created immediately before a page close, before its meta write completed.
          const existing = editor.getCurrentPageShapes().find(node => node.meta.shotQueueSessionId === batch.id && node.meta.shotQueueEntry === queueRowKey(entry));
          const shot = batch.queue.chapters[entry.chapter].shots[entry.shot];
          const props = { ...shotQueueH3Props(shot, prepared.plan, batch.queue.defaults), ...(batch.zhengbenVersion ? { zhengbenVersion: batch.zhengbenVersion } : {}) };
          // Persist a random draw before creating/posting, so reconnect never rerolls it.
          const seed = props.seedMode === "随机" ? String(crypto.getRandomValues(new Uint32Array(1))[0]) : props.seed;
          const frame = async (id: string | undefined) => { if(!id)return undefined; const asset=await getAsset(id);if(!asset||asset.recycled||asset.kind!=="image")throw Error("「"+shot.title+"」首尾帧素材缺失："+id);return {src:asset.storageReference,name:asset.filename,sourceNodeId:""}; };
          const chapterSizes = batch.queue.chapters.map((chapter) => chapter.shots.length);
          prebuildGuard();const node = existing ?? await createNode({...props,seedMode:"固定",seed,...(shot.firstFrameAssetId?{videoFirstFrame:await frame(shot.firstFrameAssetId)}:{}),...(shot.lastFrameAssetId?{videoLastFrame:await frame(shot.lastFrameAssetId)}:{})}, queueNodePosition(batch.origin, index, undefined, { chapter: entry.chapter, shot: entry.shot, chapterSizes }),prebuild.signal);
          if (!node) throw new Error("H3 节点创建失败，尚未提交生成");
          prebuildGuard();entry.nodeId = node.id;
          editor.updateShape({ id: node.id as TLShape["id"], type: "h3-node", meta: { ...(editor.getShape(node.id as TLShape["id"])?.meta ?? {}), shotQueueSessionId: batch.id, shotQueueEntry: queueRowKey(entry), ...(hasQueueFrameSources(shot) ? {shotQueueFrameWaiting:true,shotQueueFrameSources:queueFrameDescription(shot)} : {}) } });
          await persistScoped(batch);
        }
        // Verify tldraw's own IndexedDB writer saved every new node before any /prompt call.
        callbacks.current.message("全部节点已创建，正在确认画布保存，再提交任务…");
        for (let attempt = 0; attempt < 20; attempt++) {
          prebuildGuard();
          const records = new Map(batch.entries.flatMap(entry => {
            const shape = editor.getShape(entry.nodeId as TLShape["id"]);
            return shape ? [[shape.id, shape] as [string, unknown]] : [];
          }));
          try { await waitForCanvasSave(persistenceKey, records, { attempts: 1 }); break; }
          catch (cause) { if (attempt === 19) throw cause; }
        }
        prebuildGuard();
        return {batch,rootKind,resumeEligible,framePlan,frameIO,plans};
      },{signal:controller.signal,waitMs:5000,workMs:45000});
      if(!prepared)return;
      const {batch,rootKind,resumeEligible,framePlan,frameIO,plans}=prepared;
        const submissionEntries = framePlan ? framePlan.order.map(key => batch.entries.find(entry => queueRowKey(entry) === key)!) : batch.entries;
        for (const entry of submissionEntries) {
          guard();
          if(entry.removedAt||entry.cancelRequestedAt||entry.cancelledAt||(retryTarget&&entry.nodeId!==retryTarget.nodeId)){summary.skipped++;summary.notReached--;continue;}
          if(!entryDue(entry)){summary.skipped++;summary.notReached--;continue;}
          const shotPreview = batch.queue.chapters[entry.chapter].shots[entry.shot];
          const disposition=shotFileDisposition(batch,queueRowKey(entry),readInboxRootSnapshot());
          if(disposition!=='ready'){entry.waitingReason=disposition==='skip'?'文件skipShots：本镜跳过，保留原产物':'等待上游：来源镜头被skipShots跳过';await save(batch);summary.skipped++;summary.notReached--;continue;}
          await abortable(waitForInboxRootControl(shotPreview.firstFrameFrom||shotPreview.lastFrameFrom?'chain':rootKind,guard,say,batch.id),controller.signal);
          if (framesOnly && !(shotPreview.firstFrameFrom || shotPreview.lastFrameFrom)) { summary.notReached--; summary.skipped++; continue; }
          if (chapterIndex !== undefined && entry.chapter !== chapterIndex) continue;
          const runs = await listRuns();
          if (framesOnly && latestQueueRun(entry,runs)?.status === 'cancelled') { summary.skipped++; summary.notReached--; continue; }
          if(resumeEligible && (!entry.nodeId || !resumeEligible.has(entry.nodeId) || runs.some(run=>run.ownerNodeId===entry.nodeId&&!provenPreparationNotSent(run)))){summary.skipped++;summary.notReached--;continue;}
          const proofEligible=resumeEligible?.has(entry.nodeId??'') && runs.some(run=>run.ownerNodeId===entry.nodeId&&provenPreparationNotSent(run)) && !runs.some(run=>run.ownerNodeId===entry.nodeId&&!provenPreparationNotSent(run));
          if (!proofEligible && !maySubmitQueueEntry(entry, runs, retryOnly)) {
            const uncertain = queueEntryUncertain(entry, runs);
            if (uncertain) summary.uncertain++; else summary.skipped++;
            summary.notReached--;
            if (retryOnly && entry.outcome === "failed") {
              const run = latestQueueRun(entry, runs);
              const title = batch.queue.chapters[entry.chapter]?.shots[entry.shot]?.title ?? queueRowKey(entry);
              retryBlocked.push(run && run.status !== "failed"
                ? `「${title}」节点最新任务是 ${run.status}，不是明确失败`
                : entry.submissionState === "started" || entry.submissionState === "accepted"
                  ? `「${title}」提交状态仍是 ${entry.submissionState}，需先核实原任务`
                  : `「${title}」暂不能重试`);
            }
            const sourceUnconfirmedTail = uncertain && (!!shotPreview.firstFrameFrom || !!shotPreview.lastFrameFrom) && typeof entry.error === "string" && (entry.error.includes("原任务在队列与历史中无法确认") || entry.error.includes("来源任务状态不明"));
            if (uncertain && !retryOnly && !framesOnly && !sourceUnconfirmedTail) throw new SubmissionUncertainError("此镜已有状态待确认的提交记录，请先核实原任务；不会越过它继续新提交");
            continue;
          }
          if (framesOnly && !entry.nodeId) { summary.notReached--; summary.skipped++; continue; }
          if (!plans[batch.entries.indexOf(entry)].plan) { summary.failed++; summary.notReached--; continue; }
          setBusyChapter(entry.chapter);
          setRows(current => ({ ...current, [queueRowKey(entry)]: { status: "submitting", detail: "准备素材并提交到 ComfyUI" } }));
          const shot=batch.queue.chapters[entry.chapter].shots[entry.shot];
          if (framePlan && frameIO && hasQueueFrameSources(shot)) {
            setRows(current => ({...current,[queueRowKey(entry)]:{status:'pending',detail:'第二阶段：等待来源视频完成并核实截帧'}}));
            let framesReady = false;
            while (!framesReady) {
            try {
              // Each continuation waits only for its own source inside resolveQueueFrameInputs.
              // Other primaries that are still queued or running must not block a source that already has a video.
              callbacks.current.message(`第二阶段「${shot.title}」：${queueFrameDescription(shot)}；独立生成，不合并原片。`);
              const attemptId=crypto.randomUUID(),lockName=`frameflow-entry-prep:${batch.id}:${queueRowKey(entry)}`;
              const now=Date.now();entry.execution={attemptId,phase:'extracting',startedAt:now,lastProgressAt:now,leaseUntil:now+25000,lockName,requestId:entry.rerun?.requestId};
              await persist(batch,controller.signal);
              const result=await boundedLock(lockName,async scope=>{
                const check=()=>{scope.check();guard();if(entry.execution?.attemptId!==attemptId)throw Error('旧尝试已过期');};
                const phase=async(phase:EntryPhase,reason?:string)=>{check();entry.execution={...entry.execution!,phase,reason,lastProgressAt:Date.now()};await persist(batch,scope.signal);check();};
                return resolveQueueFrameInputs(batch,entry,{...frameIO,signal:scope.signal,guard:check,
                  onPhase:phase,
                  storeFrame:(url,name,source)=>storeQueueFrame(url,name,source,scope.signal),
                  extract:(src,edge)=>edge==='first'?extractVideoFirstFrame(src,scope.signal):extractVideoFrameAt(src,Number.MAX_SAFE_INTEGER,scope.signal),
                  enhanceTail:(frame,checkpoint)=>enhanceQueueTailFrame(frame,checkpoint,check,stage=>callbacks.current.message(stage),batch.id,scope.signal),
                  saveFrame:async(edge,input)=>{check();entry.frameInputs={...entry.frameInputs,[edge]:input};await persist(batch,scope.signal);check();}});
              },{signal:controller.signal,workMs:25000,ifAvailable:true});
              if(!result)throw new QueueFrameWaitingError('另一执行器正在准备同一镜，下一轮核实');
              entry.frameInputs=result;
              entry.frameToken ??= crypto.randomUUID();
              entry.waitingReason = undefined;
              if(entry.execution)entry.execution={...entry.execution,phase:'ready_to_submit',lastProgressAt:Date.now(),nextRetryAt:undefined,leaseUntil:0};
              await save(batch); guard();
              const node = editor.getShape(entry.nodeId as TLShape['id']);
              if (!node) throw framesOnly ? new QueueFrameWaitingError('续段节点不在当前页，未自动提交') : new Error('续段节点已移除，不会重建或提交');
              editor.updateShape({id:node.id,type:'h3-node',props:{
                ...(entry.frameInputs.first ? {videoFirstFrame:{src:entry.frameInputs.first.src,name:entry.frameInputs.first.name,sourceNodeId:entry.frameInputs.first.sourceNodeId}} : {}),
                ...(entry.frameInputs.last ? {videoLastFrame:{src:entry.frameInputs.last.src,name:entry.frameInputs.last.name,sourceNodeId:entry.frameInputs.last.sourceNodeId}} : {}),
                // 🧪 frameFrom time anchors: static (assetId) anchors were set at node creation; extracted ones replace any earlier extraction.
                ...(shot.timeAnchors?.some(anchor=>anchor.frameFrom) ? {timeAnchors:[
                  ...(((node.props as {timeAnchors?:{storageReference:string;filename:string;atSeconds:number;asReference?:boolean;assetId?:string}[]}).timeAnchors??[]).filter(anchor=>anchor.assetId)),
                  ...shot.timeAnchors.flatMap((anchor,index)=>{const input=entry.frameInputs?.[`anchor:${index}`];return anchor.frameFrom&&input?[{storageReference:input.src,filename:input.name,atSeconds:anchor.atSeconds,...(anchor.asReference?{asReference:true}:{})}]:[];}),
                ]} : {}),
              },meta:{...node.meta,shotQueueFrameWaiting:false,shotQueueFrameToken:entry.frameToken,shotQueueFrameSources:queueFrameDescription(shot)}});
              await abortable(waitForCanvasSave(persistenceKey,new Map([[node.id,editor.getShape(node.id)]]), { attempts: 100, readRecords: () => {
                guard();
                const current = editor.getShape(node.id);
                if (!current) throw new Error('续段节点已移除，不会提交');
                return new Map([[node.id,current]]);
              } }),controller.signal); guard();
              framesReady = true;
            } catch (cause) {
              if (cause instanceof SubmissionUncertainError) {
                entry.waitingReason = undefined;
                entry.error = cause.message;
                entry.outcome = "uncertain";
                await save(batch);
                summary.uncertain++; summary.notReached--;
                setRows(current => ({ ...current, [queueRowKey(entry)]: { status: "unconfirmed", detail: entry.error ?? "来源状态未确认" } }));
                break;
              }
              if(cause instanceof Error&&cause.name==='OperationTimeout')cause=new QueueFrameWaitingError(cause.message,true);
              if (!(cause instanceof QueueFrameWaitingError)) throw cause;
              entry.waitingReason = cause.message;
              const now=Date.now();entry.execution={attemptId:entry.execution?.attemptId??crypto.randomUUID(),phase:cause.phase??(cause.retryable?'retry_wait':'waiting_source'),startedAt:entry.execution?.startedAt??now,lastProgressAt:now,nextRetryAt:now+(cause.retryable?15000:5000),leaseUntil:0,lockName:entry.execution?.lockName??'',reason:cause.message,requestId:entry.rerun?.requestId};
              await save(batch);
              setRows(current => ({...current,[queueRowKey(entry)]:{status:'pending',detail:cause.message}}));
              // Stay pending and move to the next tail. Retrying here holds the only submit controller, fileResume stays busy, and later tails whose sources already finished never reach Comfy.
              if (cause.retryable && /无法读取或截帧/.test(cause.message)) {
                summary.notReached--; summary.skipped++;
                break;
              }
              summary.notReached--; summary.skipped++;
              break;
            }
            }
            if (!framesReady) continue;
            setRows(current => ({...current,[queueRowKey(entry)]:{status:'submitting',detail:'来源画面已保存，准备提交独立片段'}}));
          }
          reportInboxRequest(originalPage, batch.queue, "submitting", { sessionId: batch.id });
          focusNode(entry.nodeId!);
          let state = readH3Automation(entry.nodeId!);
          for (let attempt = 0; attempt < 80 && (!state?.enqueue || !state.taskMode || (entry.frameToken && state.queueFrameToken !== entry.frameToken)); attempt++) {
            guard(); await sleep(150); state = readH3Automation(entry.nodeId!);
          }
          if (!state?.enqueue || !state.taskMode || (entry.frameToken && state.queueFrameToken !== entry.frameToken)) throw new Error("节点暂未就绪，请稍后继续入队；不会创建重复节点");
          await abortable(waitForInboxRootControl(shot.firstFrameFrom||shot.lastFrameFrom?'chain':rootKind,guard,say,batch.id),controller.signal);
          entry.submissionState = "started";
          if(entry.execution)entry.execution={...entry.execution,phase:'submitting',lastProgressAt:Date.now(),leaseUntil:Date.now()+120000};
          await save(batch); // Durable uncertainty fence; never call /prompt if this write fails.
          guard();
          try {
            await bounded(scope=>state!.enqueue(shot.firstFrameFrom||shot.lastFrameFrom?'chain':rootKind,batch.id,scope.signal),120000,controller.signal,'镜头提交');
          } catch (cause) {
            const voiceNotSent=missingPrimaryVoice(cause instanceof Error?cause.message:null) && !(await listRuns()).some(run=>run.ownerNodeId===entry.nodeId);
            const kind = voiceNotSent && !controller.signal.aborted ? 'not_sent' : classifyQueueSubmissionError(cause, controller.signal.aborted);
            if (kind === "aborted") throw cause; // Preserve original outcome/error; never relabel a user stop as failed.
            entry.error = cause instanceof Error ? cause.message : "提交失败";
            entry.outcome = kind === "not_sent" ? "failed" : "uncertain";
            entry.submissionState = kind === "not_sent" ? "pending" : "started";
            if(cause instanceof PreparationUnavailableError){
              const failed=latestQueueRun(entry,await listRuns());
              if(failed&&!failed.submissionSnapshot&&failed.submission==='reserved')await updateRun(failed.runId,{status:'failed',preparationNotSent:{checkedAt:new Date().toISOString(),promptId:failed.comfyPromptId??failed.runId,workflowCaptureAbsent:true}});
            }
            if (kind === "not_sent") summary.failed++; else summary.uncertain++;
            summary.notReached--;
            await save(batch);
            setRows(current => ({ ...current, [queueRowKey(entry)]: { status: kind === "not_sent" ? "failed" : "unconfirmed", detail: entry.error ?? "状态待确认" } }));
            if (kind !== "not_sent" || cause instanceof PreparationUnavailableError) throw cause;
            continue;
          }
          entry.error = undefined; entry.outcome = undefined; entry.submissionState = "accepted";
          if(entry.execution)entry.execution={...entry.execution,phase:'queued',lastProgressAt:Date.now(),leaseUntil:0};
          await save(batch); // A storage error is NOT a submission failure and cannot advance the batch.
          summary.submitted++; summary.notReached--;
          setRows(current => ({ ...current, [queueRowKey(entry)]: { status: "queued", detail: "已进入 ComfyUI 队列" } }));
        }
        guard();
        if (retryOnly && summary.submitted === 0) {
          say(describe() + (retryBlocked.length ? "" : "没有镜头被重新入队。"));
        } else {
          say(describe() + "ComfyUI逐个执行。明确失败可单独重试；状态不明请先核实，不要重提。");
        }

    } catch (cause) {
      reportInboxRequest(originalPage, queue, "blocked", { sessionId: session.current?.id, error: cause instanceof Error ? cause.message : "提交中断，需核对Run，禁止自动重提" });
      say(retryOnly && !(controller.signal.aborted || cause instanceof QueuePersistenceError)
        ? (cause instanceof Error ? cause.message : "失败重试未执行")
        : describe() + (controller.signal.aborted ? "已停止继续提交。正在执行的镜头保留。" : cause instanceof QueuePersistenceError ? cause.message : `提交暂停：${cause instanceof Error ? cause.message : "未知错误"}。节点和任务记录已保留；请勿反复重提状态待确认的任务。`));
    } finally {
      if (controller.signal.aborted && userStop.current && session.current?.pageId === originalPage && stopRef.current === controller) {
        // Bounded: a hung ComfyUI /queue must not keep the cards locked forever.
        const saved = session.current;
        try { await bounded(() => stopWaiting(saved), 8000, undefined, '撤下排队'); }
        catch (cause) { callbacks.current.message(`无法确认后续排队是否已撤下：${cause instanceof Error ? cause.message : "连接中断"}；请检查 ComfyUI，不会中断当前任务。`); }
      }
      // After 强制解锁 a newer submit may own the controller: leave its state alone.
      const owner = stopRef.current === controller || stopRef.current === null;
      if (stopRef.current === controller) stopRef.current = null;
      if (owner && submitPhase.current === 'active') submitPhase.current = null;
      if (owner) { setBusyChapter(null); setRunningAll(false); setStuck(false); }
    }
    };
    try {
      await previous;
      // 等前一次同页提交结束期间，若用户点了「停止后续排队」或已切页/卸载，则直接取消本次排队提交
      if (!mounted.current || editor.getCurrentPageId() !== entryPage || stopEpoch.current !== stopEpochAtEntry) return;
      const runningLockName = `frameflow-shot-queue-running:${entryPage}`;
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request(runningLockName, { ifAvailable: true }, async lock => {
          if (!lock) {
            const msg = "另一个画布标签页正在提交本页队列，请先在那个标签页停止或等待其完成。";
            say(msg);
            if (queue && matchingInboxRequest(entryPage, queue)) reportInboxRequest(entryPage, queue, "blocked", { error: msg });
            return;
          }
          await runExclusive();
        });
      } else {
        await runExclusive();
      }
    } finally {
      if (isManual) manualSubmitActive.current = false;
      releaseTail();
    }
  };
  /**
   * 停止后续排队。几秒内必有结果：每一步都有时限，报错都写成提示，不会被吞掉。
   * 不取消 ComfyUI 里正在跑的任务；只撤下本批还在 ComfyUI 排队、没开始的。
   */
  const stop = async () => {
    const say = (text: string) => callbacks.current.message(text);
    const reason = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
    stopEpoch.current += 1;
    userStop.current = true;
    const controller = stopRef.current;
    controller?.abort(new DOMException('用户点了「停止后续排队」', 'AbortError'));
    setStopping(true);
    say(controller ? "正在停止后续排队…（正在 ComfyUI 生成的镜头保留）" : "正在把本批标成停止…");
    const notes: string[] = [];
    let cancelled: string[] = [];
    try {
      const saved = session.current;
      // Wait for the loop at the same time as the cleanup, so 强制解锁 appears after STOP_EXIT_MS at the latest.
      const exitWait = controller ? waitUntil(() => stopRef.current !== controller, STOP_EXIT_MS, 100, sleep) : Promise.resolve(true);
      const cleanup = (async () => {
        if (!saved) return;
        saved.autoContinueFrames = false; saved.stoppedAt = Date.now(); setStoppedAt(saved.stoppedAt);
        try { await bounded(scope => persist(saved, scope.signal), 6000, undefined, '写停止标记'); }
        catch (cause) { notes.push(`停止标记没写进本地记录（${reason(cause)}），刷新后如果又开始排队，请再点一次停止`); }
        try { cancelled = await bounded(() => stopWaiting(saved), 6000, undefined, '撤下排队'); }
        catch (cause) { notes.push(`没能确认 ComfyUI 排队里的本批任务已撤下（${reason(cause)}），请看一眼 ComfyUI；正在跑的不受影响`); }
      })();
      const exited = await exitWait;
      if (!exited) { setStuck(true); say(`提交循环 ${STOP_EXIT_MS / 1000} 秒内没退出：可以点「强制解锁」。正在撤下 ComfyUI 排队里的本批任务…`); }
      await cleanup;
      const runs = saved ? await bounded(() => listRuns(), 4000, undefined, '读取任务').catch(() => null) : [];
      if (runs === null) notes.push('任务记录读取超时，上面的数字可能不全');
      const states: StopShotState[] = (saved?.entries ?? []).map(entry => {
        if (entry.removedAt || entry.cancelledAt) return 'removed';
        const run = latestQueueRun(entry, runs ?? []);
        if (run?.status === 'completed') return 'completed';
        if (run?.status === 'cancelled') return 'cancelled';
        if (queueEntryUncertain(entry, runs ?? [])) return 'unconfirmed';
        if (run?.status === 'running') return 'running';
        if (run?.status === 'queued') return 'queued';
        if (run?.status === 'failed' || entry.outcome === 'failed') return 'failed';
        return 'pending';
      });
      say(describeStop({ states, cancelledNow: cancelled.length, exited, wasRunning: !!controller, notes }));
      return { exited, cancelled: cancelled.length };
    } catch (cause) {
      say(`停止时出错：${reason(cause)}。${stopRef.current ? '提交循环可能还卡着，可以点「强制解锁」。' : '提交循环已经退出。'}`);
      if (stopRef.current) setStuck(true);
      return { exited: !stopRef.current, cancelled: cancelled.length };
    } finally { setStopping(false); }
  };
  /** 实在停不掉时的出路：直接放开界面。后果见 FORCE_UNLOCK_NOTE（不碰 ComfyUI 里的任务）。 */
  const forceUnlock = () => {
    stopEpoch.current += 1;
    userStop.current = true;
    stopRef.current?.abort(new DOMException('用户强制解锁', 'AbortError'));
    stopRef.current = null; submitPhase.current = null;
    manualSubmitActive.current = false;
    sameTabTail.current = Promise.resolve();
    setBusyChapter(null); setRunningAll(false); setStuck(false); setStopping(false);
    callbacks.current.message('已' + FORCE_UNLOCK_NOTE);
  };
  const removeEntry = async (chapter: number, shot: number, nextQueue: ShotQueue | null) => {
    if (stopRef.current) throw new Error("提交期间不能删除镜头");
    const saved = session.current;
    if (!saved || JSON.stringify(saved.queue) !== JSON.stringify(queueRef.current)) return;
    if (saved.queue.chapters.some(c => c.shots.some(s => s.firstFrameFrom || s.lastFrameFrom))) assertQueueFrameRemoval(saved.queue,chapter,shot);
    setLoadedPage("");
    try {
      if (!nextQueue) {
        await putMeta(queueSessionKey(pageId), null);
        session.current = null;
        return;
      }
      const chapterRemoved = saved.queue.chapters[chapter]?.shots.length === 1;
      if (nextQueue.chapters.some(c => c.shots.some(s => s.firstFrameFrom || s.lastFrameFrom))) queueFramePlan(nextQueue);
      const entries = saved.entries.filter(entry => entry.chapter !== chapter || entry.shot !== shot).map(entry => ({
        ...entry, chapter: entry.chapter - (chapterRemoved && entry.chapter > chapter ? 1 : 0),
        shot: entry.shot - (entry.chapter === chapter && entry.shot > shot ? 1 : 0),
      }));
      await persist({ ...saved, queue: nextQueue, entries });
    } finally { setLoadedPage(pageId); }
  };
  const hasActive = Object.values(rows).some(row => ["queued", "running", "unconfirmed"].includes(row.status));
  const failedCount = useValue("retryable current queue nodes", () => {
    const saved = session.current;
    if (!queue || !saved || saved.pageId !== pageId || JSON.stringify(saved.queue) !== JSON.stringify(queue)) return 0;
    return saved.entries.filter(entry => entry.outcome === "failed" && entry.submissionState !== "started" && entry.submissionState !== "accepted"
      && !entry.removedAt && !entry.cancelRequestedAt && !entry.cancelledAt
      && (!entry.nodeId || !!editor.getShape(entry.nodeId as TLShape["id"]))).length;
  }, [editor, pageId, queue, rows, ready]);
  const recoveryActions={
    shotAction:async(target:InboxShotTarget)=>{
      if(target.pageId!==pageId||editor.getCurrentPageId()!==pageId||!ready||stopRef.current)throw Error('原页未就绪或提交控制器仍在工作；不会中断本批其他镜头');
      const saved=await loadSession();
      const entry=saved?.entries.find(e=>e.nodeId===target.nodeId);
      const node=editor.getShape(target.nodeId as TLShape['id']);
      if(!saved||saved.id!==target.sessionId||!entry||entry.removedAt||!node||node.meta.shotQueueSessionId!==saved.id||node.meta.shotQueueEntry!==queueRowKey(entry)||JSON.stringify(saved.queue)!==JSON.stringify(queue))throw Error('原会话/节点不匹配，未创建或替换节点');
      if(target.action==='retry_failed'){
        // Only this node is selected; history is checked again under the submission lock.
        void submit(undefined,true,false,undefined,target);
        return {state:'retry_requested',nodeId:target.nodeId,note:'仅原节点失败重试意图；请核对该镜新Run和promptId，不代表GPU已接单'};
      }
      return withLock(`frameflow-shot-queue-submit:${pageId}`,async()=>{
        const fresh=await loadSession();
        if(!fresh||fresh.id!==target.sessionId)throw Error('原会话已变化');
        return cancelInboxShot(fresh,target.nodeId,{runs:listRuns,probe:run=>comfyUIH3Adapter.probeJob(run.comfyPromptId!,saveNodeForRun(run)),persist:()=>persist(fresh),
          cancel:async id=>{const response=await fetch('/comfyui/api/jobs/'+encodeURIComponent(id)+'/cancel',{method:'POST',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('单镜取消接口失败；不使用全局中断');const result=await response.json() as {cancelled?:boolean};if(!result.cancelled)throw Error('后台未接受单镜取消');},
          update:run=>updateRun(run.runId,{status:'cancelled',completedAt:Date.now(),error:'用户按原会话取消此镜；其他节点保留'}).then(()=>{}),
        });
      });
    },
    voiceNone:async(target:InboxVoiceNoneTarget)=>{
      if(target.pageId!==pageId||editor.getCurrentPageId()!==pageId||stopRef.current)throw Error('请保持原页且停止提交后再修改');
      const saved=await loadSession();
      if(!saved||saved.id!==target.sessionId||!saved.entries.some(e=>e.nodeId===target.nodeId))throw Error('原会话/节点不匹配');
      if((await listRuns()).some(run=>run.ownerNodeId===target.nodeId))throw Error('此节点已有Run，禁止修改或重提');
      const node=editor.getShape(target.nodeId as TLShape['id']);
      if(!node||node.type!=='h3-node')throw Error('原节点缺失');
      const props=node.props as {dialogueLines?:{roleId:string;text:string;speaker?:string;voice?:string}[]};
      const before=props.dialogueLines;const line=before?.[target.lineIndex];
      if(!line||line.roleId!==target.expectedRoleId||line.text!==target.expectedText)throw Error('台词已变化，未修改');
      const role=(await listRoles()).find(r=>r.roleId===line.roleId);if(!role)throw Error('原角色缺失');
      const after=before!.map((item,i)=>i===target.lineIndex?{roleId:'',speaker:role.displayName,voice:'none',text:item.text}:item);
      editor.updateShape({id:node.id,type:'h3-node',props:{dialogueLines:after}});
      await waitForCanvasSave(persistenceKey,new Map([[node.id,editor.getShape(node.id)]]),{attempts:100,readRecords:()=>new Map([[node.id,editor.getShape(node.id)]])});
      return {nodeId:node.id,before,after,saved:true};
    },
    diagnose:async(sessionId:string)=>{
      const saved=await loadSession();
      if(!saved||saved.id!==sessionId)throw Error("找不到原会话，未创建替代会话");
      const records=new Map(saved.entries.flatMap(entry=>{const shape=entry.nodeId?editor.getShape(entry.nodeId as TLShape["id"]):undefined;return entry.nodeId?[[entry.nodeId,shape] as [string,unknown]]:[];}));
      const fingerprint=JSON.stringify([...records]);
      const diagnostic=await diagnoseCanvasRecords(persistenceKey,records);
      const liveChangedDuringRead=JSON.stringify(saved.entries.map(entry=>[entry.nodeId,entry.nodeId?editor.getShape(entry.nodeId as TLShape["id"]):undefined]))!==fingerprint;
      const owned=(await listRuns()).filter(run=>saved.entries.some(entry=>entry.nodeId===run.ownerNodeId));
      const tasks=await Promise.all(owned.map(async run=>({nodeId:run.ownerNodeId,runId:run.runId,promptId:run.comfyPromptId,status:run.status,submission:run.submission,error:run.error,hasSubmissionSnapshot:!!run.submissionSnapshot,startedAt:run.startedAt,outputCount:run.outputAssetIds.length,
        ...(run.comfyPromptId?{probe:await comfyUIH3Adapter.probeJob(run.comfyPromptId,saveNodeForRun(run)).catch(cause=>({error:cause instanceof Error?cause.message:String(cause)}))}:{})})));
      const frameIntegrity=await Promise.all(saved.entries.filter(entry=>entry.frameInputs).map(async entry=>({nodeId:entry.nodeId,frames:await Promise.all(Object.entries(entry.frameInputs!).map(async([edge,frame])=>({edge,...await auditQueueFrame(frame!,latestQueueRun(entry,owned)).catch(error=>({error:String(error)}))})))})));
      return {frameIntegrity,pageId,sessionId,checkedAt:new Date().toISOString(),...diagnostic,matches:diagnostic.matches&&!liveChangedDuringRead,liveChangedDuringRead,tasks,nodes:saved.entries.map(entry=>({nodeId:entry.nodeId,execution:entry.execution,chapter:entry.chapter,shot:entry.shot,submissionState:entry.submissionState,outcome:entry.outcome,error:entry.error,uncertain:queueEntryUncertain(entry,owned),exists:!!entry.nodeId&&!!editor.getShape(entry.nodeId as TLShape["id"])}))};
    },
    resume:async(target:InboxResumeTarget)=>{
      if(target.pageId!==pageId||editor.getCurrentPageId()!==pageId||!ready||!queue||stopRef.current)throw Error("请保持原仙侠页和队列就绪，且不要并行恢复");
      const saved=await loadSession();
      if(!saved||saved.id!==target.sessionId||JSON.stringify(saved.queue)!==JSON.stringify(queue))throw Error("原会话与当前队列不一致，禁止新建或替换");
      const runs=await listRuns();
      if(target.allowPreparationRepair){
        for(const entry of saved.entries){
          const run=latestQueueRun(entry,runs);
          if(!run){
            if(missingPrimaryVoice(entry.error)){entry.submissionState='pending';entry.outcome='failed';}
            continue;
          }
          if(queueEntryUncertain(entry,runs)&&run.comfyPromptId){
            const accepted=await comfyUIH3Adapter.probeJob(run.comfyPromptId,saveNodeForRun(run));
            if(accepted.state!=='not_found'){
              // Positive server evidence resolves a lost HTTP acknowledgment; never post this Run again.
              run.submission='accepted';run.status=accepted.state==='failed'?'failed':accepted.state==='running'?'running':'queued';run.error=accepted.state==='failed'?(accepted.error??'ComfyUI执行失败'):null;
              await updateRun(run.runId,{submission:run.submission,status:run.status,error:run.error});
              entry.submissionState='accepted';entry.outcome=undefined;entry.error=undefined;
              continue;
            }
          }
          if(!legacyPreparationNotSentCandidate(run)&&!provenPreparationNotSent(run))continue;
          if(!run.comfyPromptId)throw Error('旧失败Run缺少原prompt_id');
          const probe=await comfyUIH3Adapter.probeJob(run.comfyPromptId,saveNodeForRun(run));
          if(probe.state!=='not_found')throw Error('旧失败任务已有服务端记录，禁止按未提交修复');
          // Enqueue persists onPrepared's workflow before /prompt. Its absence PLUS the exact precheck error proves this failure never reached submission.
          run.preparationNotSent={checkedAt:new Date().toISOString(),promptId:run.comfyPromptId,historyState:'not_found',workflowCaptureAbsent:true};
          await updateRun(run.runId,{preparationNotSent:run.preparationNotSent});
          entry.submissionState='pending';entry.outcome=undefined;entry.error=undefined;
        }
        await persist(saved);
      }
      const records=new Map(saved.entries.flatMap(entry=>{const shape=entry.nodeId?editor.getShape(entry.nodeId as TLShape["id"]):undefined;return shape?[[shape.id,shape] as [string,unknown]]:[];}));
      planInboxResume(saved,runs,new Map(editor.getCurrentPageShapes().map(shape=>[shape.id,shape])),target.allowPreparationRepair);
      const liveRecords=()=>new Map(saved.entries.flatMap(entry=>{const node=entry.nodeId?editor.getShape(entry.nodeId as TLShape['id']):undefined;return node?[[node.id,node] as [string,unknown]]:[];}));
      // Runtime badges/layout can settle after metadata repair. Wait for the real writer, never bypass it.
      await waitForCanvasSave(persistenceKey,records,{attempts:100,readRecords:liveRecords});
      if(!(await diagnoseCanvasRecords(persistenceKey,liveRecords())).matches)throw Error("原节点保存仍有差异，禁止恢复；请先查看保存诊断文件");
      const jobs=await comfyUIH3Adapter.queueJobs();
      const ownAccepted=new Set(runs.filter(run=>run.submission==='accepted'&&saved.entries.some(entry=>entry.nodeId===run.ownerNodeId)).map(run=>run.comfyPromptId));
      if(jobs.some(id=>!ownAccepted.has(id)))throw Error("ComfyUI有其他任务或未知任务，暂停恢复；本批已接单任务保留");
      for(const run of runs.filter(run=>saved.entries.some(entry=>entry.nodeId===run.ownerNodeId))){
        if(!run.comfyPromptId){if(target.allowPreparationRepair)continue;throw Error("已有Run缺少prompt_id，需人工核对，不自动重提");}
        const probe=await comfyUIH3Adapter.probeJob(run.comfyPromptId,saveNodeForRun(run));
        if(provenPreparationNotSent(run)){if(probe.state!=='not_found')throw Error('未提交凭证与服务端记录冲突');continue;}
        if(probe.state==='not_found'||((probe.state==='queued'||probe.state==='running')&&run.submission!=='accepted')){
          if(target.allowPreparationRepair)continue; // Preserve uncertainty and skip this node; never post it again.
          throw Error("原任务历史未明确终结，暂停恢复");
        }
      }
      beginInboxRequest({id:target.requestId,pageId,sessionId:saved.id,queueJson:JSON.stringify(saved.queue),phase:"session_created"});
      void submit(undefined,false,false,target).catch(cause=>reportInboxRequest(pageId,saved.queue,"blocked",{sessionId:saved.id,error:cause instanceof Error?cause.message:String(cause)}));
    },
  };
  const recoveryRef=useRef(recoveryActions);
  // Fresh closures without remounting/aborting the queue execution owner.
  useEffect(()=>{ recoveryRef.current=recoveryActions; });
  useEffect(()=>registerInboxRecovery(pageId,{diagnose:id=>recoveryRef.current.diagnose(id),resume:target=>recoveryRef.current.resume(target),voiceNone:target=>recoveryRef.current.voiceNone(target),shotAction:target=>recoveryRef.current.shotAction(target),
    yield:async(signal)=>{signal?.throwIfAborted();stopRef.current?.abort();return !stopRef.current;},
    activateFileSession:async (target,signal)=>{
      signal?.throwIfAborted();
      if(stopRef.current){stopRef.current.abort();return false;}
      if(target.pageId!==pageId||editor.getCurrentPageId()!==pageId||target.stoppedAt||target.autoContinueFrames!==true)throw Error('目标页/会话不符或已停止，不切换批次');
      assertInboxSessionActive(target.id);
      for(const entry of target.entries)if(!entry.removedAt&&entry.nodeId&&!editor.getShape(entry.nodeId as TLShape['id']))throw Error('目标批次原节点丢失，不复建');
      await waitForCanvasSave(persistenceKey,new Map(Object.entries(getSnapshot(editor.store).document.store)));
      signal?.throwIfAborted();const previous=await loadSession();signal?.throwIfAborted();if(previous&&previous.id!==target.id)await rememberFileSession(previous);
      persisted.current.set(target.id,structuredClone(target));await persist(target,signal,true);signal?.throwIfAborted();callbacks.current.restore(target.queue);return false;
    },
    recoverTail:async target=>{
      if(stopRef.current||target.pageId!==pageId||editor.getCurrentPageId()!==pageId)throw Error('原控制器尚未停止或画布页不符，不恢复');
      const saved=await loadSession();if(!saved||saved.id!==target.sessionId||saved.stoppedAt||saved.autoContinueFrames!==true)throw Error('原会话不符或已停止');
      assertInboxSessionActive(saved.id);const entry=saved.entries.find(e=>e.nodeId===target.nodeId),frame=entry?.frameInputs?.[target.edge];
      if(!entry||entry.removedAt||entry.cancelledAt||entry.cancelRequestedAt||!frame||frame.enhancement?.originalAssetId!==target.output.originalAssetId)throw Error('原节点/截帧绑定已变化');
      const node=editor.getShape(target.nodeId as TLShape['id']);if(!node||node.meta.shotQueueSessionId!==saved.id||node.meta.shotQueueEntry!==queueRowKey(entry))throw Error('原节点缺失或绑定不符，不恢复');
      const run=latestQueueRun(entry,await listRuns());if(run&&['queued','running'].includes(run.status))throw Error('原镜头仍已接单，不改其输入');
      const recovered=await recoverTailOutput(target.output);assertInboxSessionActive(saved.id);
      const retiredHeld=target.output.retireUnexecutedHeld?await retireInvalidHeldTail({sessionId:saved.id,nodeId:target.nodeId,edge:target.edge,oldSrc:frame.src,recognizedOutputSha256:target.output.expectedOutputSha256}):undefined;
      const fresh=await loadSession();if(!fresh||fresh.id!==saved.id)throw Error('原会话已变化，高清产物保留但未挂镜头');
      const current=fresh.entries.find(e=>e.nodeId===target.nodeId);if(!current||current.removedAt||current.cancelledAt||current.cancelRequestedAt||fresh.stoppedAt)throw Error('镜头已删除/取消/停止，不挂接');
      const newest=latestQueueRun(current,await listRuns());if(newest&&['queued','running'].includes(newest.status))throw Error('镜头已有新任务，高清产物保留但不改变已提交输入');
      current.frameInputs={...current.frameInputs,[target.edge]:{...frame,src:recovered.asset.storageReference,name:recovered.asset.filename,width:recovered.asset.width!,height:recovered.asset.height!,enhancement:{originalAssetId:target.output.originalAssetId,promptId:target.output.promptId,completedAssetId:recovered.asset.assetId}}};
      await persist(fresh);return {state:'recovered_not_submitted',nodeId:target.nodeId,assetId:recovered.asset.assetId,receipt:recovered.receipt,retiredHeld,note:'只认回已验证的原高清输出，未提交GPU；坏图资产保留'};
    },
    fileResume:async (id,signal)=>{
      signal?.throwIfAborted();
      if(stopRef.current){
        // Legacy submit closures have no phase. They can sit in the old all-primary wait
        // after a hot update. Abort only that local controller; userStop stays false,
        // so accepted ComfyUI jobs are not removed from the queue.
        if(submitPhase.current!==null)return {state:'busy'};
        stopRef.current.abort();
        for(let attempt=0;attempt<150&&stopRef.current;attempt++){signal?.throwIfAborted();await sleep(200);}
        if(stopRef.current)return {state:'busy'};
      }
      const saved=await loadSession();signal?.throwIfAborted();if(!saved||saved.id!==id||saved.stoppedAt||saved.autoContinueFrames!==true)throw Error('已停止/未授权/会话不符，不恢复');
      if(!ready||JSON.stringify(queue)!==JSON.stringify(saved.queue))return {state:'waiting_page'};
      assertInboxSessionActive(id);signal?.throwIfAborted();void submit(undefined,false,false,undefined,undefined,true).catch(error=>callbacks.current.message('执行器失败：'+String(error)));return {state:'accepted'};
    },
    fileRerun:async(selector,requestId,signal)=>{
      signal?.throwIfAborted();
      if(stopRef.current){
        stopRef.current.abort();
        for(let attempt=0;attempt<150&&stopRef.current;attempt++){signal?.throwIfAborted();await sleep(200);}
        if(stopRef.current)return {state:'waiting_controller'};
      }
      const saved=await loadSession();signal?.throwIfAborted();if(!saved||saved.id!==selector.sessionId||!ready||JSON.stringify(saved.queue)!==JSON.stringify(queue))return {state:'waiting_page'};
      assertInboxSessionActive(saved.id);
      if(!saved.entries.some(e=>e.rerun?.requestId===requestId)){
        const runs=await listRuns(),keys=prepareFileRerun(structuredClone(saved),selector,runs,requestId);
        for(const entry of saved.entries.filter(e=>keys.includes(queueRowKey(e)))){if(!entry.nodeId||!editor.getShape(entry.nodeId as TLShape['id']))throw Error('重渲原节点不存在，不创建替代节点');const run=latestQueueRun(entry,runs);if(!run)continue;const probe=await comfyUIH3Adapter.probeJob(run.comfyPromptId!,saveNodeForRun(run));if(!rerunProbeAllows(run,probe.state)&&!(probe.state==='not_found'&&await retiredHeldAllows(saved.id,entry.nodeId,run.comfyPromptId!)))throw Error('原history未确认终态，禁止重渲');}
        signal?.throwIfAborted();prepareFileRerun(saved,selector,runs,requestId);await persist(saved,signal);signal?.throwIfAborted();
      }
      signal?.throwIfAborted();void submit(undefined,false,false,undefined,undefined,true).catch(error=>callbacks.current.message('执行器失败：'+String(error)));return {state:'accepted',requestId};
    }
  }),[pageId,ready,queue]);
  /** Read-only look before a manual 入队: will it start a new batch, and which shots already have a node with video? */
  const previewStart = async (chapterIndex?: number): Promise<BatchStartPlan | null> => {
    if (!queue || !ready) return null;
    const saved = await getMeta<QueueSession>(queueSessionKey(pageId));
    const savedQueue = saved?.version === 1 && saved.pageId === pageId ? saved.queue : null;
    return planBatchStart({ savedQueue, queue, nodes: pageQueueNodes(), runs: await listRuns(), chapterIndex });
  };
  return { rows, setRows, ready, removeEntry, busyChapter, runningAll, hasActive, failedCount, previewStart, retryFailed: () => submit(undefined, true), submit: (index: number, explicitResume = false, reuse?: 'skip' | 'rerender') => submit(index, false, false, undefined, undefined, false, explicitResume, reuse), submitAll: (explicitResume = false, reuse?: 'skip' | 'rerender') => submit(undefined, false, false, undefined, undefined, false, explicitResume, reuse), resumeFrames: () => submit(undefined, false, true), stop, forceUnlock, stopping, stuck, stoppedAt, loopRunning: busyChapter !== null, isSubmitting: () => stopRef.current !== null };
}
