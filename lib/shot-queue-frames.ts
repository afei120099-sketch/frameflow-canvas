import type { ShotQueue, ShotQueueShot } from './shot-queue.ts';
import { maySubmitQueueEntry, queueEntryUncertain, type QueueEntry, type QueueSession } from './shot-queue-session.ts';
import type { AssetRecord, RunRecord } from './production-records.ts';
import { SubmissionUncertainError } from './ai-adapter.ts';
import type {QueueFrameRunObservation} from './queue-frame-run-observer.ts';

export type QueueFrameSource = { shot?: string; shotId?: string; shotNumber?: number; frame: 'first' | 'last' };
export type QueueFrameInput = {
  src: string; name: string; sourceNodeId: string; sourceShot: string;
  sourceRunId: string; sourceAssetId: string; sourceStorageReference: string;
  sourceFrame: 'first' | 'last'; seconds: number; width: number; height: number;
  enhancement?: {originalAssetId:string;promptId?:string;completedAssetId?:string};
};
/** first / last frame edges plus 🧪 time anchors (`anchor:N`, N = index in shot.timeAnchors). */
export type QueueFrameEdge = 'first' | 'last' | `anchor:${number}`;
/** Every video-frame source of a shot. Only tail frames feeding first / last are HD-enhanced; anchors are cropped at submit. */
export function queueFrameSources(shot: ShotQueueShot): { edge: QueueFrameEdge; from: QueueFrameSource; enhance: boolean }[] {
  return [
    ...(shot.firstFrameFrom ? [{ edge: 'first' as const, from: shot.firstFrameFrom, enhance: shot.firstFrameFrom.frame === 'last' }] : []),
    ...(shot.lastFrameFrom ? [{ edge: 'last' as const, from: shot.lastFrameFrom, enhance: shot.lastFrameFrom.frame === 'last' }] : []),
    ...(shot.timeAnchors ?? []).flatMap((anchor, index) => anchor.frameFrom ? [{ edge: `anchor:${index}` as const, from: anchor.frameFrom, enhance: false }] : []),
  ];
}
export const hasQueueFrameSources = (shot: ShotQueueShot) => queueFrameSources(shot).length > 0;
export function queueFrameDescription(shot: ShotQueueShot) {
  return [shot.firstFrameFrom ? `首帧←${frameSourceLabel(shot.firstFrameFrom)}的${shot.firstFrameFrom.frame === 'last' ? '尾' : '首'}帧` : '',
    shot.lastFrameFrom ? `尾帧←${frameSourceLabel(shot.lastFrameFrom)}的${shot.lastFrameFrom.frame === 'first' ? '首' : '尾'}帧` : '',
    ...(shot.timeAnchors ?? []).flatMap((anchor) => anchor.frameFrom ? [`🧪锚点${anchor.atSeconds}秒←${frameSourceLabel(anchor.frameFrom)}的${anchor.frameFrom.frame === 'last' ? '尾' : '首'}帧`] : [])].filter(Boolean).join('；');
}
export const frameSourceLabel = (from: QueueFrameSource) => from.shot ?? from.shotId ?? `第${from.shotNumber}镜`;
/** Queue-only gate. Manual node「生成视频」must not use this to block the user. */
export const queueFrameNodeWaiting = (meta: Record<string, unknown> | undefined, renderedToken?: unknown) =>
  meta?.shotQueueFrameWaiting === true ? '等待队列提取来源视频画面，请在镜头队列继续；队列不会提前生成或自动改成普通参考'
    : meta?.shotQueueFrameToken && meta.shotQueueFrameToken !== renderedToken ? '来源帧仍在加载，请稍后继续' : '';

export function parseQueueFrameSource(value: unknown, where: string): QueueFrameSource | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(where + '需要 {shot, frame}');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !['shot','shotId','shotNumber','frame'].includes(key))) throw Error(where + '只支持 shot / shotId / shotNumber 和 frame');
  if (['shot','shotId','shotNumber'].filter(key=>source[key]!==undefined).length!==1) throw Error(where+' 必须且只能选择 shot / shotId / shotNumber 一种引用');
  if (source.shot !== undefined && (typeof source.shot !== 'string' || !source.shot.trim() || source.shot.trim().length > 80)) throw Error(where + '.shot 需要唯一镜头标题或 previous');
  if (source.shotId !== undefined && (typeof source.shotId !== 'string' || !source.shotId.trim() || source.shotId.trim().length > 80)) throw Error(where + '.shotId 需要非空稳定ID');
  if (source.shotNumber !== undefined && (!Number.isSafeInteger(source.shotNumber) || Number(source.shotNumber)<1)) throw Error(where + '.shotNumber 必须是从1开始的全队列镜号');
  if (source.frame !== 'first' && source.frame !== 'last') throw Error(where + '.frame 必须为 first / last');
  return { ...(typeof source.shot === 'string'?{shot:source.shot.trim()}:{}), ...(typeof source.shotId === 'string'?{shotId:source.shotId.trim()}:{}), ...(typeof source.shotNumber === 'number'?{shotNumber:source.shotNumber}:{}), frame: source.frame };
}

/** Source titles are resolved once against original order; forward references are allowed, cycles are not. */
export function queueFramePlan(queue: ShotQueue) {
  const flat = queue.chapters.flatMap((chapter, c) => chapter.shots.map((shot, s) => ({shot, key:`${c}:${s}`})));
  const sourceKey = (reference: string | QueueFrameSource, owner: string) => {
    const from: Pick<QueueFrameSource,'shot'|'shotId'|'shotNumber'> = typeof reference === 'string' ? {shot:reference} : reference;
    const title = from.shot;
    const at = flat.findIndex(item => item.key === owner);
    if (from.shotNumber !== undefined) {
      if (!flat[from.shotNumber-1]) throw Error(`来源镜号 ${from.shotNumber} 不存在`);
      return flat[from.shotNumber-1].key;
    }
    if (from.shotId !== undefined) {
      const matches = flat.filter(item=>item.shot.shotId===from.shotId);
      if(matches.length!==1)throw Error(`来源 shotId「${from.shotId}」不存在或不唯一`);
      return matches[0].key;
    }
    if (title === 'previous') {
      if (at < 1) throw Error('首镜不能引用 previous');
      return flat[at - 1].key;
    }
    const matches = flat.filter(item => item.shot.title === title);
    if (matches.length !== 1) throw Error(`来源镜头「${title}」不存在或标题不唯一`);
    return matches[0].key;
  };
  const dynamic = flat.filter(item => hasQueueFrameSources(item.shot));
  const main = flat.filter(item => !hasQueueFrameSources(item.shot)).map(item => item.key);
  const errors:string[]=[];
  const resolve=(reference:string|QueueFrameSource,owner:string)=>{
    try{return sourceKey(reference,owner);}catch(error){errors.push(`镜头 ${owner}：${error instanceof Error?error.message:String(error)}`);return undefined;}
  };
  const dependencies = new Map(dynamic.map(item => [item.key, queueFrameSources(item.shot).map(source => resolve(source.from,item.key)).filter((key):key is string=>key!==undefined)]));
  const sorted: string[] = [], active = new Set<string>(), done = new Set<string>();
  const visit = (key: string) => {
    if (active.has(key)) throw Error('首尾帧来源存在循环或引用自身');
    if (done.has(key) || !dependencies.has(key)) return;
    active.add(key); for (const dep of dependencies.get(key)!) visit(dep);
    active.delete(key); done.add(key); sorted.push(key);
  };
  for (const item of dynamic)try{visit(item.key);}catch(error){errors.push(`镜头 ${item.key}：${error instanceof Error?error.message:String(error)}`);active.clear();}
  if(errors.length)throw Error([...new Set(errors)].join('\n'));
  return { main, dynamic: sorted, order: [...main, ...sorted], sourceKey };
}

export function assertQueueFrameRemoval(queue: ShotQueue, chapter: number, shot: number) {
  const plan = queueFramePlan(queue), target = `${chapter}:${shot}`;
  queue.chapters.forEach((c,ci) => c.shots.forEach((s,si) => {
    if (`${ci}:${si}` === target) return;
    for (const {from} of queueFrameSources(s)) if (plan.sourceKey(from,`${ci}:${si}`) === target) throw Error(`「${s.title}」仍依赖此镜头的画面，请先修改或移除续段；原视频和节点不会删除`);
  }));
}

/** Recoverable input problem, not a submitted/failed generation. Leave this entry pending. */
export class QueueFrameWaitingError extends Error {
  retryable: boolean;
  phase?:'waiting_source'|'waiting_hd'|'blocked';
  constructor(message: string, retryable = false,phase?:'waiting_source'|'waiting_hd'|'blocked') { super(message); this.retryable = retryable;this.phase=phase; }
}
const PERMANENT_FRAME_IO = /图片内容为空或全零|图片文件头无效|图片解码|SHA-256|已保存截帧与来源不匹配|没有有效画面|视频文件为空|尾帧高清没有可用成品|本地视频数据不存在|已丢失或回收|旧尾帧高清任务尚未核实/;
const TRANSIENT_FRAME_IO = /Failed to fetch|超时|请重试|network|ECONNRESET|ETIMEDOUT|load failed|connection/i;
// Retry scheduling is durable and outside this preparation attempt. No in-lock retry loop.
/** Network / timeout while reading, extracting, storing, or enhancing a completed source. Do not retry missing files or invalid frames. */
export function isTransientQueueFrameIoError(cause: unknown) {
  if (cause instanceof QueueFrameWaitingError || cause instanceof SubmissionUncertainError) return false;
  if (cause instanceof DOMException && cause.name === 'AbortError') return false;
  if (cause instanceof DOMException && cause.name === 'TimeoutError') return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (PERMANENT_FRAME_IO.test(message)) return false;
  if (cause instanceof TypeError) return true;
  return TRANSIENT_FRAME_IO.test(message);
}
type FrameIO = {
  signal?:AbortSignal;
  onPhase?:(phase:import('./queue-entry-state.ts').EntryPhase,reason?:string)=>Promise<void>;
  guard: () => void; runs: () => Promise<RunRecord[]>;
  asset: (id: string) => Promise<AssetRecord | null>;
  read: (source: string) => Promise<Blob>; pause: () => Promise<void>;
  extract: (source: string, frame: 'first' | 'last') => Promise<{dataUrl:string;seconds:number;width:number;height:number}>;
  /** Stores the extracted frame and returns its `image:` reference; without it the frame stays inline (tests only). */
  storeFrame?: (dataUrl:string,name:string,source:{assetId:string;seconds:number;width:number;height:number}) => Promise<string>;
  saveFrame?: (edge:QueueFrameEdge,input:QueueFrameInput) => Promise<void>;
  enhanceTail?: (input:QueueFrameInput,checkpoint:(input:QueueFrameInput)=>Promise<void>) => Promise<QueueFrameInput>;
  observeRun?: (run: RunRecord) => Promise<QueueFrameRunObservation>;
  onWaiting?: (message: string) => void;
};
const keyOf = (entry: QueueEntry) => `${entry.chapter}:${entry.shot}`;
/** Stored `image:` references are current; inline `data:image/` frames are accepted from older sessions. */
export const isQueueFrameSource = (src: string) => src.startsWith('image:') || src.startsWith('data:image/');
const latest = (entry: QueueEntry, runs: RunRecord[]) => !entry.nodeId ? undefined : runs.filter(run => run.ownerNodeId === entry.nodeId).sort((a,b) => b.createdAt - a.createdAt)[0];
function rejectUncertain(entry: QueueEntry, run: RunRecord | undefined) {
  if (run && (['running','completed','failed','cancelled'].includes(run.status) || (run.status === 'queued' && run.submission !== 'reserved'))) return;
  if (entry.outcome === 'uncertain' || entry.submissionState === 'started' || run?.submission === 'reserved' || (!run && entry.submissionState === 'accepted')) throw new SubmissionUncertainError('来源任务状态不明，请先核实原任务；不会重提或换用其他视频');
}

/** Unsubmitted or uncertain primaries do not block unrelated continuations. Each dependent checks its own source. */
function primaryStillRendering(entry: QueueEntry, run: RunRecord | undefined) {
  try { rejectUncertain(entry, run); }
  catch (cause) { if (cause instanceof SubmissionUncertainError) return false; throw cause; }
  return run?.status === 'running' || run?.status === 'queued';
}
/** Phase 2 waits only for primaries that are actually queued or running. */
export async function waitForQueuePrimaries(batch: QueueSession, io: FrameIO) {
  const keys = new Set(queueFramePlan(batch.queue).main);
  for (;;) {
    io.guard(); const runs = await io.runs(); io.guard(); let active = false;
    for (const entry of batch.entries.filter(e => !e.removedAt && !e.cancelRequestedAt && !e.cancelledAt && keys.has(keyOf(e)))) {
      const run = latest(entry, runs);
      if (run && primaryStillRendering(entry, run)) {
        const observed = await io.observeRun?.(run); io.guard();
        if (observed === 'failed' || observed === 'not_found' || observed === 'unconfirmed') continue;
        if (observed === 'waiting_connection') io.onWaiting?.('来源查询连接暂断，保留原任务并等待重连；不会重新提交');
        active = true;
      }
    }
    if (!active) return;
    await io.pause();
  }
}
/** Saved-session continuations only. Never used to invent a new batch from edited JSON. */
export function frameEntriesToResume(batch: QueueSession, runs: RunRecord[]) {
  // Legacy sessions have no durable evidence that the user left continuation enabled.
  if(batch.autoContinueFrames!==true || batch.stoppedAt)return [];
  let dynamic: Set<string>;
  try { dynamic = new Set(queueFramePlan(batch.queue).dynamic); }
  catch { return []; }
  const started = batch.entries.some(entry => {
    const run = latest(entry, runs);
    return !!run || entry.submissionState === 'accepted' || entry.submissionState === 'started' || entry.outcome === 'failed';
  });
  if (!started) return [];
  return batch.entries.filter(entry => !queueRerunDependencyPending(batch,entry,runs) && dynamic.has(keyOf(entry)) && !!entry.nodeId && latest(entry, runs)?.status !== 'cancelled' && maySubmitQueueEntry(entry, runs) && !queueEntryUncertain(entry, runs));
}

/** Only ancestors of an unsubmitted rerun are fenced. Unrelated chains stay ready. */
export function queueRerunDependencyPending(batch:QueueSession,entry:QueueEntry,runs:RunRecord[]){
  const plan=queueFramePlan(batch.queue),seen=new Set<string>();
  const blocked=(item:QueueEntry):boolean=>{const key=keyOf(item);if(seen.has(key))return false;seen.add(key);
    const shot=batch.queue.chapters[item.chapter].shots[item.shot];
    return queueFrameSources(shot).some(({from:ref})=>{
      const dep=batch.entries.find(e=>keyOf(e)===plan.sourceKey(ref,key))!;
      const run=latest(dep,runs);
      return !!(dep.rerun&&(!run||run.runId===dep.rerun.previousRunId))||blocked(dep);
    });};
  return blocked(entry);
}

export async function resolveQueueFrameInputs(batch: QueueSession, entry: QueueEntry, io: FrameIO) {
  if (entry.removedAt || entry.cancelRequestedAt || entry.cancelledAt) throw new QueueFrameWaitingError('续段已删除或取消，不会恢复或提交');
  const shot = batch.queue.chapters[entry.chapter].shots[entry.shot], plan = queueFramePlan(batch.queue);
  const inputs: NonNullable<QueueEntry['frameInputs']> = {};
  for (const { edge, from, enhance } of queueFrameSources(shot)) {
    const dependency = batch.entries.find(item => keyOf(item) === plan.sourceKey(from,keyOf(entry)));
    const sourceLabel=frameSourceLabel(from);
    if (dependency?.removedAt || dependency?.cancelRequestedAt || dependency?.cancelledAt) throw new QueueFrameWaitingError(`来源「${sourceLabel}」已删除或取消，不会恢复或提交`);
    await io.onPhase?.('waiting_source');
    if (!dependency?.nodeId) throw new QueueFrameWaitingError(`来源「${sourceLabel}」节点尚未就绪`);
    let frozen = entry.frameInputs?.[edge];

    for (;;) {
      io.guard(); const runs = await io.runs(); io.guard();
      if(queueRerunDependencyPending(batch,entry,runs))throw new QueueFrameWaitingError('等待上游重渲提交；不会使用重渲前的旧尾帧');
      if(frozen&&dependency.rerun?.previousRunId===frozen.sourceRunId)frozen=undefined;
      const run = frozen ? runs.find(r => r.runId === frozen!.sourceRunId && r.ownerNodeId === dependency.nodeId) : latest(dependency,runs);
      if (!frozen) rejectUncertain(dependency,run);
      if (!run || run.status === 'failed' || run.status === 'cancelled') {
        const sourceFailed = !run ? dependency.outcome === 'failed' || dependency.outcome === 'uncertain' : true;
        throw new QueueFrameWaitingError(`来源「${sourceLabel}」尚未成功，相关片段保留等待，不影响其他来源`, !sourceFailed);
      }
      if (run.status !== 'completed') {
        const observed = await io.observeRun?.(run); io.guard();
        if (observed === 'failed') throw new QueueFrameWaitingError(`来源「${sourceLabel}」后台任务未成功，相关片段保留等待，不会自动重试来源`);
        if (observed === 'not_found' || observed === 'unconfirmed') throw new SubmissionUncertainError(`来源「${sourceLabel}」原任务在队列与历史中无法确认；不会重提或换用其他视频`);
        // A second miss is still the same shot. A live queue must not pin the only submit controller.
        if (observed === 'checking') throw new QueueFrameWaitingError(`来源「${sourceLabel}」历史待复核；下一轮继续查询原任务`);
        if (observed === 'waiting_connection') io.onWaiting?.('来源查询连接暂断，保留原任务并等待重连；不会重新提交');
        throw new QueueFrameWaitingError(`来源「${sourceLabel}」仍在排队或处理中，本镜稍后继续；没有继承首帧不会生成视频`);
      }
      const videos = (await Promise.all(run.outputAssetIds.map(id => io.asset(id)))).filter((asset): asset is AssetRecord => !!asset && asset.kind === 'video');
      io.guard();
      const asset = frozen ? videos.find(a => a.assetId === frozen!.sourceAssetId) : videos.length === 1 ? videos[0] : undefined;
      if (!asset || asset.recycled || (frozen && asset.storageReference !== frozen.sourceStorageReference)) throw new QueueFrameWaitingError(`来源「${sourceLabel}」视频缺失、已回收或输出不唯一，请先核对`);
      try {
        // An already-reserved tail HD only needs a queue check. Re-reading the source video on every pass would hold the scheduler again.
        const pollingReservedHd = !!frozen?.enhancement?.promptId && !frozen.enhancement.completedAssetId && isQueueFrameSource(frozen.src);
        if (!pollingReservedHd) {
          const blob = await io.read(asset.storageReference); io.guard();
          if (!blob.size) throw Error('视频文件为空');
        }
        if (frozen) {
          if (frozen.sourceFrame !== from.frame || frozen.sourceNodeId !== dependency.nodeId || !isQueueFrameSource(frozen.src)) throw Error('已保存截帧与来源不匹配');
          inputs[edge] = frozen;
        } else {
          await io.onPhase?.('extracting');
          const frame = await io.extract(asset.storageReference,from.frame); io.guard();
          if (!frame.dataUrl.startsWith('data:image/') || frame.width <= 0 || frame.height <= 0) throw Error('没有有效画面');
          const name = `${asset.filename}-${from.frame === 'last' ? '尾' : '首'}帧.${frame.dataUrl.startsWith('data:image/png') ? 'png' : 'jpg'}`;
          const src = io.storeFrame ? await io.storeFrame(frame.dataUrl,name,{assetId:asset.assetId,seconds:frame.seconds,width:frame.width,height:frame.height}) : frame.dataUrl; io.guard();
          inputs[edge] = { src, name, sourceNodeId:dependency.nodeId,
            sourceShot:batch.queue.chapters[dependency.chapter].shots[dependency.shot].title, sourceRunId:run.runId, sourceAssetId:asset.assetId,
            sourceStorageReference:asset.storageReference, sourceFrame:from.frame, seconds:frame.seconds, width:frame.width,height:frame.height };
        }
        // Persist the exact source BEFORE a GPU enhancement can be reserved.
        // Source tails may feed either the next clip's first or last input.
        const checkpoint=async(input:QueueFrameInput)=>{io.guard();inputs[edge]=input;await io.saveFrame?.(edge,input);io.guard();};
        await checkpoint(inputs[edge]!);
        if(enhance&&io.enhanceTail){
          await io.onPhase?.('waiting_hd');
          const enhanced=await io.enhanceTail(inputs[edge]!,checkpoint);io.guard();
          if(!enhanced.enhancement?.completedAssetId||!isQueueFrameSource(enhanced.src)||enhanced.width<=0||enhanced.height<=0)throw Error('尾帧高清没有可用成品，不会使用低清图提交');
          await checkpoint(enhanced);
        }
      } catch (cause) {
        io.guard();
        if (cause instanceof QueueFrameWaitingError || cause instanceof SubmissionUncertainError) throw cause;
        if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
        // Reserved tail HD is still behind other Comfy jobs. Leave the checkpoint, do not post it again, and let the next continuation run.
        if (cause instanceof Error && cause.name === 'FrameEnhanceQueuedError') throw new QueueFrameWaitingError(`来源「${sourceLabel}」${cause.message}，本镜稍后继续；不会改用低清图，也不会重复提交`,false,'waiting_hd');
        if(cause instanceof Error&&/原增强任务.*状态待确认/.test(cause.message))throw new QueueFrameWaitingError(cause.message,false,'waiting_hd');
        const transient = isTransientQueueFrameIoError(cause);
        const detail = cause instanceof Error ? cause.message : '未知错误';
        throw new QueueFrameWaitingError(`来源「${sourceLabel}」无法读取或截帧：${detail}`, transient,transient?undefined:'blocked');
      }
      break;
    }
  }
  return inputs;
}
