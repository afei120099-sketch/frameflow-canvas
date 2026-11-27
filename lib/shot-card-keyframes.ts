/**
 * 镜头卡片「先出关键帧」：在画布页面里用 Flux Dev（+ PuLID 锁脸，+ 分镜深度图）出候选关键帧。
 * 参数和原生产线 lib/production/graphs.ts buildKeyframeGraph 一致（同一个 buildStoryboardPrompt、24 步、guidance 10）。
 *
 * 一次只跑一张（GPU 只有一块）。任务在模块里排队，关掉卡片面板也会继续；刷新页面会丢掉还没开始的任务，
 * 已提交给 ComfyUI 的那张由 ComfyUI 跑完，但结果不会回到卡片（和画布 Flux 节点一样，需要重新出）。
 * 所以：有任务没出完时离开/刷新页面浏览器会先问；没出完的任务清单记在本标签页的 sessionStorage，刷新后卡片明确提示哪些丢了。
 * 刷新后不会自动重出（不悄悄占 GPU），由用户再点「出关键帧」。
 * 候选记录存在 meta 里（按队列标题 + 镜头标题），通过的那张写进队列 JSON 的 firstFrameAssetId；「另存成新队列」时整本复制到新标题。
 */
import { runFluxDev } from "./comfyui/flux-dev.ts";
import { buildStoryboardPrompt, STORYBOARD_FLUX } from "./keyframe-storyboard.ts";
import { getLocalImageBlob, storeLocalImage } from "./local-video-store.ts";
import { getAsset, getMeta, putMeta, registerAsset } from "./production-records.ts";
import type { RoleRecord } from "./role-records.ts";
import { keyframeCount, keyframeDepth, type KeyframeDefaults, type ShotKeyframe } from "./shot-queue-keyframe.ts";

export interface KeyframeCandidate { assetId: string; seed: number; createdAt: number; rejected?: boolean }
export type CandidateBook = Record<string, KeyframeCandidate[]>;
export interface KeyframeJob { id: string; queueTitle: string; shotTitle: string; index: number; total: number; state: "waiting" | "running" | "failed"; stage: string; error?: string }

/** Sizes: multiples of 16, ≤1536 on the long side, ~1.3 MP like the production line's 864×1536. */
export const KEYFRAME_SIZES: Record<string, { width: number; height: number }> = {
  "9:16": { width: 864, height: 1536 }, "16:9": { width: 1536, height: 864 },
  "1:1": { width: 1152, height: 1152 }, "4:3": { width: 1344, height: 1008 }, "3:4": { width: 1008, height: 1344 },
};

const metaKey = (queueTitle: string) => `shot-card-keyframes:v1:${queueTitle}`;
export const loadCandidates = async (queueTitle: string) => (await getMeta<CandidateBook>(metaKey(queueTitle))) ?? {};
let writes = Promise.resolve();
async function updateCandidates(queueTitle: string, change: (book: CandidateBook) => CandidateBook) {
  // Serialised read-modify-write: two finished jobs must not overwrite each other's candidate.
  const run = writes.then(async () => { const next = change(await loadCandidates(queueTitle)); await putMeta(metaKey(queueTitle), next); return next; });
  writes = run.then(() => undefined, () => undefined);
  return run;
}
export const setRejected = (queueTitle: string, shotTitle: string, assetId: string, rejected: boolean) =>
  updateCandidates(queueTitle, (book) => ({ ...book, [shotTitle]: (book[shotTitle] ?? []).map((item) => item.assetId === assetId ? { ...item, rejected } : item) }));
/** 「另存成新队列」: the new queue title starts with every candidate of the old one (merged by assetId, nothing removed). */
export const copyQueueCandidates = async (fromQueue: string, toQueue: string) => {
  if (fromQueue === toQueue) return loadCandidates(toQueue);
  const source = await loadCandidates(fromQueue);
  return updateCandidates(toQueue, (book) => {
    const next: CandidateBook = { ...book };
    for (const [shot, list] of Object.entries(source)) {
      const have = new Set((next[shot] ?? []).map((item) => item.assetId));
      next[shot] = [...(next[shot] ?? []), ...list.filter((item) => !have.has(item.assetId))];
    }
    return next;
  });
};
/** After a shot is renamed or copied, its candidates follow the new title. */
export const copyCandidates = (queueTitle: string, from: string, to: string) => updateCandidates(queueTitle, (book) => book[from] ? { ...book, [to]: [...book[from]] } : book);

/* ── one-at-a-time job queue, shared by every card board instance ── */
type Listener = () => void;
const jobs: KeyframeJob[] = [];
const listeners = new Set<Listener>();
let running = false;
/** Unfinished jobs of THIS tab survive a refresh only as a notice (sessionStorage is per tab, so other canvas tabs never count). */
export interface LostKeyframeJob { queueTitle: string; shotTitle: string; index: number; total: number; state: "waiting" | "running" }
const PENDING_KEY = "frameflow.shotCard.keyframeJobs.pending.v1";
const LOST_KEY = "frameflow.shotCard.keyframeJobs.lost.v1";
const readList = (key: string): LostKeyframeJob[] => { try { const value = JSON.parse(globalThis.sessionStorage?.getItem(key) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } };
const writeList = (key: string, list: LostKeyframeJob[]) => { try { if (list.length) globalThis.sessionStorage?.setItem(key, JSON.stringify(list)); else globalThis.sessionStorage?.removeItem(key); } catch { /* notice only */ } };
let lost: LostKeyframeJob[] = [...readList(LOST_KEY), ...readList(PENDING_KEY)];
writeList(LOST_KEY, lost); writeList(PENDING_KEY, []);
export const lostKeyframeJobs = () => lost.slice();
export const dismissLostKeyframeJobs = () => { lost = []; writeList(LOST_KEY, []); emit(); };
export const keyframeJobsPending = () => jobs.some((job) => job.state !== "failed");
/** Leave-page warning, attached only while keyframe jobs are pending and removed once they are all done or failed. */
const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
let unloadGuarded = false;
const syncUnloadGuard = () => {
  const pending = keyframeJobsPending();
  if (typeof window === "undefined" || pending === unloadGuarded) return;
  if (pending) window.addEventListener("beforeunload", warnBeforeUnload);
  else window.removeEventListener("beforeunload", warnBeforeUnload);
  unloadGuarded = pending;
};
const emit = () => {
  writeList(PENDING_KEY, jobs.flatMap((job) => job.state === "failed" ? [] : [{ queueTitle: job.queueTitle, shotTitle: job.shotTitle, index: job.index, total: job.total, state: job.state }]));
  syncUnloadGuard();
  listeners.forEach((listener) => listener());
};
export const subscribeKeyframeJobs = (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const keyframeJobs = () => jobs.slice();

export interface KeyframeRequest {
  queueTitle: string; shotTitle: string; aspect: string;
  keyframe: ShotKeyframe; defaults?: KeyframeDefaults;
  roles: readonly RoleRecord[];
  count?: number;
}

/** Face reference for PuLID: the role's dedicated face still, else its main appearance. */
function faceAssetId(roles: readonly RoleRecord[], roleId?: string) {
  if (!roleId) return null;
  const role = roles.find((item) => item.roleId === roleId);
  if (!role) throw new Error("锁脸的角色不在角色库里");
  return role.faceReferenceAssetId ?? role.primaryAppearanceAssetId ?? null;
}

export function enqueueKeyframes(request: KeyframeRequest) {
  const size = KEYFRAME_SIZES[request.aspect];
  if (!size) throw new Error(`关键帧不支持 ${request.aspect} 画幅`);
  if (!request.keyframe.prompt.trim()) throw new Error("关键帧描述是空的");
  const total = request.count ?? keyframeCount(request.keyframe, request.defaults);
  const face = faceAssetId(request.roles, request.keyframe.faceRoleId);
  for (let index = 0; index < total; index++) {
    const job: KeyframeJob = { id: crypto.randomUUID(), queueTitle: request.queueTitle, shotTitle: request.shotTitle, index, total, state: "waiting", stage: "排队中" };
    jobs.push(job);
    const work = async () => {
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      const [faceAsset, boardAsset] = await Promise.all([face ? getAsset(face) : null, request.keyframe.storyboardAssetId ? getAsset(request.keyframe.storyboardAssetId) : null]);
      if (face && !faceAsset) throw new Error("锁脸的脸部图找不到了");
      if (request.keyframe.storyboardAssetId && !boardAsset) throw new Error("分镜图找不到了");
      const [faceImage, depthImage] = await Promise.all([faceAsset ? getLocalImageBlob(faceAsset.storageReference) : undefined, boardAsset ? getLocalImageBlob(boardAsset.storageReference) : undefined]);
      const result = await runFluxDev({
        prompt: buildStoryboardPrompt(request.defaults?.look ?? "", request.keyframe.prompt),
        width: size.width, height: size.height, seed, steps: STORYBOARD_FLUX.steps, guidance: 10, sampler: "euler", scheduler: "simple", extraLora: true, denoise: 1,
        ...(depthImage ? { depthImageName: "pending-storyboard.png", depthStrength: keyframeDepth(request.keyframe, request.defaults) } : {}),
        ...(faceImage ? { faceImageName: "pending-face.png", faceWeight: request.keyframe.faceWeight ?? STORYBOARD_FLUX.faceWeight } : {}),
      }, { faceImage, depthImage, onStage: (stage) => { job.stage = stage; emit(); } });
      const filename = `关键帧_${request.shotTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}_${seed}.png`;
      const src = await storeLocalImage(result.image, filename);
      const asset = await registerAsset({ kind: "image", origin: "generated", filename, mimeType: "image/png", storageReference: src, sourceRunId: null, width: size.width, height: size.height, fileSize: result.image.size });
      await updateCandidates(request.queueTitle, (book) => ({ ...book, [request.shotTitle]: [...(book[request.shotTitle] ?? []), { assetId: asset.assetId, seed, createdAt: Date.now() }] }));
    };
    (job as KeyframeJob & { work?: () => Promise<void> }).work = work;
  }
  emit();
  void pump();
}

async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = jobs.find((item) => item.state === "waiting") as (KeyframeJob & { work?: () => Promise<void> }) | undefined;
      if (!job) break;
      job.state = "running"; job.stage = "提交 Flux"; emit();
      try { await job.work!(); jobs.splice(jobs.indexOf(job), 1); }
      catch (cause) { job.state = "failed"; job.error = cause instanceof Error ? cause.message : String(cause); }
      emit();
    }
  } finally { running = false; emit(); }
}

/** Remove failed rows, and waiting ones when asked (running jobs are already with ComfyUI). */
export function clearKeyframeJobs(includeWaiting: boolean) {
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].state === "failed" || (includeWaiting && jobs[i].state === "waiting")) jobs.splice(i, 1);
  emit();
}
