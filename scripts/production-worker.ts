import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ProductionComfyClient, SubmissionNotSent, SubmissionUncertain, type ComfyOutputFile, type ProductionProbe } from "../lib/production/comfy-client.ts";
import { autoApproveKeyframes, cancelOpenTasks, createEpisode, decideVersion, enqueueKeyframes, enqueueVideos, episodeSummary, parseEpisodeDefinition, requiredMedia, type Ids } from "../lib/production/episode.ts";
import { buildKeyframeGraph, buildVideoGraph, keyframeInputs, KEYFRAME_DEPTH_NODE, KEYFRAME_SAVE_NODE, planVideoSubmission, refTarget, VIDEO_SAVE_NODE, videoReferenceInputs } from "../lib/production/graphs.ts";
import { nextTask } from "../lib/production/scheduler.ts";
import { IN_FLIGHT_STATES, type Episode, type ShotSpec, type StageKind, type Task, type Version } from "../lib/production/types.ts";
import { ProductionStore } from "./production-store.ts";

/**
 * Production worker. Lives in the dev-server process (like the night shift), so closing the canvas
 * tab does not stop it. One production prompt in flight at a time; it never submits while ComfyUI
 * holds anybody else's work. Doubt about a submission pauses that episode until the user decides —
 * nothing is ever resubmitted on a guess.
 */

export interface ProductionWorkerOptions {
  root: string;
  comfy: ProductionComfyClient;
  python: string;
  checksScript: string;
  roughCutScript: string;
  report?: (line: string) => void;
  /** Throws to block a submission (GPU thermal guard). */
  beforeSubmit?: () => Promise<void>;
  /** Shared emergency stop (inbox root STOP / submit:false). Returns a reason to hold new submissions. */
  holdReason?: () => Promise<string | null>;
  /** Test hook: replaces the Python subprocess (args exclude the interpreter). */
  exec?: (args: string[], timeoutMs: number) => Promise<string>;
  pollMs?: number;
  heartbeatMs?: number;
  lockStaleMs?: number;
  now?: () => Date;
}

const MAX_NOT_SENT_RETRIES = 2;
const LOG_LIMIT = 400;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function run(python: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(python, ["-I", ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${String(stderr).slice(-800)}`)); else resolve(String(stdout));
    });
  });
}
function lastJson<T>(stdout: string): T {
  const line = stdout.trim().split(/\r?\n/).filter((item) => item.trim().startsWith("{")).at(-1);
  if (!line) throw new Error(`检查脚本没有输出结果：${stdout.slice(-300)}`);
  return JSON.parse(line) as T;
}
/** PNG IHDR width/height (keyframes are PNG). */
export function pngSize(data: Uint8Array) {
  if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export class ProductionWorker {
  readonly store: ProductionStore;
  private readonly comfy: ProductionComfyClient;
  private readonly options: ProductionWorkerOptions;
  private readonly episodes = new Map<string, Episode>();
  private damaged: { file: string; error: string }[] = [];
  private owner = false;
  private lockInfo: { pid: number; host: string; heartbeat: string } | null = null;
  /** Identifies this worker object: two workers can share a pid across a Vite restart. */
  private readonly token = randomBytes(8).toString("hex");
  private timers: ReturnType<typeof setInterval>[] = [];
  private ticking = false;
  private stopping = false;
  private lastStage: StageKind | null = null;
  private status: { state: string; detail: string; at: string } = { state: "starting", detail: "", at: new Date().toISOString() };
  private checking: Promise<void> = Promise.resolve();
  private assembling = new Set<string>();
  private deleted = new Set<string>();
  /** The task being prepared (uploads + graph) right now: still "pending" on disk, but must not be deleted under it. */
  private preparing: { episodeId: string; shotId: string } | null = null;

  constructor(options: ProductionWorkerOptions) {
    this.options = options;
    this.store = new ProductionStore(options.root);
    this.comfy = options.comfy;
  }

  private exec(args: string[], timeoutMs: number) { return this.options.exec ? this.options.exec(args, timeoutMs) : run(this.options.python, args, timeoutMs); }
  private now() { return (this.options.now ?? (() => new Date()))(); }
  private iso() { return this.now().toISOString(); }
  private report(line: string) { this.options.report?.(`[production] ${line}`); }
  private setStatus(state: string, detail = "") { this.status = { state, detail, at: this.iso() }; }
  private ids(): Ids { return { taskId: () => `t-${randomBytes(6).toString("hex")}`, seed: () => randomBytes(6).readUIntBE(0, 6) % 2 ** 48 }; }

  async start() {
    await this.store.init();
    await this.reload();
    await this.tryOwn();
    const heartbeat = this.options.heartbeatMs ?? 10_000;
    this.timers.push(setInterval(() => { void this.tryOwn().catch(() => {}); }, heartbeat));
    this.timers.push(setInterval(() => { void this.tick(); }, this.options.pollMs ?? 4000));
    void this.tick();
  }

  async stop() {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.owner) await writeFile(this.store.lockPath, JSON.stringify({ released: this.iso(), token: this.token })).catch(() => {});
    this.owner = false;
  }

  private async reload() {
    const { episodes, damaged } = await this.store.readAll();
    this.episodes.clear();
    for (const episode of episodes) this.episodes.set(episode.episodeId, episode);
    this.damaged = damaged;
  }

  /** One owner per runtime folder (several dev-server instances share this project). */
  private async tryOwn() {
    const stale = this.options.lockStaleMs ?? 45_000;
    let current: { pid?: number; host?: string; token?: string; heartbeat?: string; released?: string } | null = null;
    try { current = JSON.parse(await readFile(this.store.lockPath, "utf8")); } catch { current = null; }
    const fresh = current?.heartbeat && !current.released && Date.now() - Date.parse(current.heartbeat) < stale;
    if (fresh && current?.token !== this.token) {
      if (this.owner) this.report("另一个进程接管了生产线，本进程停止执行");
      this.owner = false;
      this.lockInfo = { pid: current!.pid ?? 0, host: current!.host ?? "", heartbeat: current!.heartbeat! };
      return;
    }
    const info = { pid: process.pid, host: hostname(), token: this.token, heartbeat: this.iso() };
    await this.store.atomicWrite(this.store.lockPath, JSON.stringify(info));
    if (!this.owner) { this.report(`生产线执行器启动（pid ${process.pid}）`); await this.reload(); }
    this.owner = true;
    this.lockInfo = info;
  }

  private async persist(episode: Episode) {
    // A deleted episode's ledger is in the trash: a late write from an in-progress step must not bring it back.
    if (this.deleted.has(episode.episodeId)) return;
    episode.updatedAt = this.iso();
    if (episode.log.length > LOG_LIMIT) episode.log.splice(0, episode.log.length - LOG_LIMIT);
    await this.store.writeEpisode(episode);
  }
  private note(episode: Episode, action: string, extra: { shotId?: string; taskId?: string; detail?: string } = {}) {
    episode.log.push({ at: this.iso(), action, ...extra });
    if (!this.deleted.has(episode.episodeId)) void this.store.log(episode.episodeId, { action, ...extra });
  }

  private requireOwner() { if (!this.owner) throw new Error("生产线执行器在另一个画布进程里运行，请在主画布（5173）操作"); }
  private require(id: string) { const episode = this.episodes.get(id); if (!episode) throw new Error("没有这个剧集"); return episode; }

  // ───────────────────────────── commands (HTTP routes call these) ─────────────────────────────

  /** `canvas` = the canvas instance asking ("" default). Each canvas sees only its own episodes; one worker runs them all. */
  overview(canvas?: string) {
    const mine = [...this.episodes.values()].filter((episode) => canvas === undefined || (episode.canvas ?? "") === canvas);
    return {
      owner: this.owner, lock: this.lockInfo, status: this.status, damaged: this.damaged,
      episodes: mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(episodeSummary),
    };
  }

  async get(id: string) {
    if (!this.owner) await this.reload();
    const episode = this.require(id);
    const media = await Promise.all(requiredMedia(episode).map(async (name) => ({ name, present: await this.store.exists(this.store.inputPath(id, name)) })));
    return { episode, media };
  }

  async createEpisode(raw: string, canvas = "") {
    this.requireOwner();
    const definition = parseEpisodeDefinition(raw);
    const at = this.now();
    const stamp = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const id = `ep-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${randomBytes(2).toString("hex")}`;
    const episode = { ...createEpisode(definition, id, at.toISOString()), ...(canvas ? { canvas } : {}) };
    this.episodes.set(id, episode);
    await this.persist(episode);
    await this.store.log(id, { action: "created", title: episode.title });
    return episode;
  }

  /** Replaces the editable parts (shots, roles, settings) and keeps tasks and versions of shots that still exist. */
  async updateDefinition(id: string, raw: string) {
    this.requireOwner();
    const episode = this.require(id);
    const definition = parseEpisodeDefinition(raw);
    Object.assign(episode, { title: definition.title, aspect: definition.aspect, roles: definition.roles, shots: definition.shots, keyframe: definition.keyframe, video: definition.video });
    const alive = new Set(definition.shots.map((shot) => shot.shotId));
    cancelOpenTasks(episode, this.iso(), (task) => !alive.has(task.shotId));
    this.note(episode, "definition_updated", { detail: `${definition.shots.length} 镜` });
    await this.persist(episode);
    return episode;
  }

  async uploadMedia(id: string, name: string, data: Uint8Array) {
    this.requireOwner();
    this.require(id);
    if (!data.byteLength || data.byteLength > 40 * 1024 * 1024) throw new Error("文件为空或超过 40MB");
    await this.store.atomicWrite(this.store.inputPath(id, name), data);
    return { name, bytes: data.byteLength };
  }

  private async missingMedia(episode: Episode, shotIds: string[], stage: StageKind) {
    const names = new Set<string>();
    for (const shot of episode.shots.filter((item) => shotIds.includes(item.shotId))) {
      if (stage === "keyframe") { const inputs = keyframeInputs(episode, shot); if (inputs.storyboard) names.add(inputs.storyboard); if (inputs.face) names.add(inputs.face); }
      else videoReferenceInputs(episode, shot).forEach((name) => names.add(name));
    }
    const missing: string[] = [];
    for (const name of names) if (!(await this.store.exists(this.store.inputPath(episode.episodeId, name)))) missing.push(name);
    return missing;
  }

  async enqueue(id: string, stage: StageKind, options: { shotIds?: string[]; count?: number } = {}) {
    this.requireOwner();
    const episode = this.require(id);
    const shotIds = options.shotIds ?? episode.shots.map((shot) => shot.shotId);
    const missing = await this.missingMedia(episode, shotIds, stage);
    if (missing.length) throw new Error(`还缺这些素材，请先上传：${missing.join("、")}`);
    const at = this.iso();
    const result = stage === "keyframe" ? { created: enqueueKeyframes(episode, this.ids(), at, options), skipped: [] as string[] } : enqueueVideos(episode, this.ids(), at, options);
    await this.persist(episode);
    void this.tick();
    return { created: result.created.length, skipped: result.skipped };
  }

  async decide(id: string, versionId: string, decision: "approved" | "rejected" | "candidate", note = "") {
    this.requireOwner();
    const episode = this.require(id);
    const version = decideVersion(episode, versionId, decision, this.iso(), note);
    await this.persist(episode);
    return version;
  }

  async setPaused(id: string, paused: boolean) {
    this.requireOwner();
    const episode = this.require(id);
    episode.paused = paused;
    this.note(episode, paused ? "paused" : "resumed");
    await this.persist(episode);
    if (!paused) void this.tick();
    return episodeSummary(episode);
  }

  /**
   * Deletes an episode from the list. Nothing is erased: the ledger and every file move to
   * <root>/trash/<id>-<time>/ so it can be restored by moving them back. Refused while ComfyUI is working on it.
   */
  async deleteEpisode(id: string) {
    this.requireOwner();
    const episode = this.require(id);
    const busy = episode.tasks.filter((task) => IN_FLIGHT_STATES.includes(task.state) || task.state === "needs_confirmation");
    if (busy.length) throw new Error(`这一集还有 ${busy.length} 个任务已提交给 ComfyUI（或待确认），等它们跑完、或先处理待确认的任务再删`);
    if (this.assembling.has(id)) throw new Error("这一集正在粗剪，完成后再删");
    if (this.preparing?.episodeId === id) throw new Error("这一集有镜头正在上传参考图、准备提交，几秒后再删");
    this.deleted.add(id);
    this.episodes.delete(id);
    try { return { trash: await this.store.trashEpisode(id, this.iso().replace(/[-:]/g, "").replace(/\..+/, "")) }; }
    catch (cause) { this.deleted.delete(id); this.episodes.set(id, episode); throw cause; }
  }

  /** Removes one shot from the episode. Its keyframes/videos stay on disk; open tasks of the shot are cancelled. */
  async deleteShot(id: string, shotId: string) {
    this.requireOwner();
    const episode = this.require(id);
    if (!episode.shots.some((shot) => shot.shotId === shotId)) throw new Error("没有这个镜头");
    if (episode.shots.length === 1) throw new Error("这是最后一镜：要删就删整集");
    const busy = episode.tasks.filter((task) => task.shotId === shotId && (IN_FLIGHT_STATES.includes(task.state) || task.state === "needs_confirmation"));
    if (busy.length) throw new Error(`${shotId} 有任务已提交给 ComfyUI（或待确认），等它跑完再删`);
    if (this.preparing?.episodeId === id && this.preparing.shotId === shotId) throw new Error(`${shotId} 正在上传参考图、准备提交，几秒后再删`);
    cancelOpenTasks(episode, this.iso(), (task) => task.shotId === shotId);
    episode.shots = episode.shots.filter((shot) => shot.shotId !== shotId);
    this.note(episode, "shot_deleted", { shotId });
    await this.persist(episode);
    return episodeSummary(episode);
  }

  async cancelPending(id: string, shotId?: string) {
    this.requireOwner();
    const episode = this.require(id);
    const cancelled = cancelOpenTasks(episode, this.iso(), (task) => !shotId || task.shotId === shotId);
    await this.persist(episode);
    return { cancelled: cancelled.length };
  }

  /** A failed task (or one ComfyUI lost) gets a fresh pending task with the same seed — only on request. */
  async retryTask(id: string, taskId: string) {
    this.requireOwner();
    const episode = this.require(id);
    const task = episode.tasks.find((item) => item.taskId === taskId);
    if (!task) throw new Error("没有这个任务");
    if (task.state !== "failed" && task.state !== "needs_confirmation") throw new Error("只有失败或待确认的任务可以重试");
    if (task.state === "needs_confirmation") { task.state = "failed"; task.error = `${task.error ?? ""}（用户确认后放弃原提交并重试）`; task.completedAt = this.iso(); }
    episode.tasks.push({ ...task, taskId: this.ids().taskId(), state: "pending", attempts: [], retries: 0, error: null, createdAt: this.iso(), startedAt: null, completedAt: null, versionId: null });
    this.note(episode, "retry", { shotId: task.shotId, taskId });
    await this.persist(episode);
    void this.tick();
    return { ok: true };
  }

  /** Needs-confirmation task the user says to drop (do not resubmit). */
  async abandonTask(id: string, taskId: string) {
    this.requireOwner();
    const episode = this.require(id);
    const task = episode.tasks.find((item) => item.taskId === taskId);
    if (!task || task.state !== "needs_confirmation") throw new Error("只有待确认的任务可以放弃");
    task.state = "failed"; task.error = `${task.error ?? ""}（用户确认放弃）`; task.completedAt = this.iso();
    await this.persist(episode);
    return { ok: true };
  }

  async rescore(id: string, versionId: string) {
    this.requireOwner();
    const episode = this.require(id);
    const version = episode.versions.find((item) => item.versionId === versionId);
    if (!version) throw new Error("没有这个版本");
    this.queueCheck(episode, version);
    return { ok: true };
  }

  // ───────────────────────────── the loop ─────────────────────────────

  async tick() {
    if (this.ticking || this.stopping || !this.owner) return;
    this.ticking = true;
    try {
      const episodes = [...this.episodes.values()];
      for (const episode of episodes) for (const task of episode.tasks.filter((item) => IN_FLIGHT_STATES.includes(item.state))) await this.advance(episode, task);
      let comfyBusy = false;
      let online = true;
      try { comfyBusy = (await this.comfy.queue()).some((item) => !item.production); } catch { online = false; }
      if (!online) { this.setStatus("offline", "ComfyUI 未连接，等待中"); return; }
      const decision = nextTask({ episodes, comfyBusy, lastStage: this.lastStage });
      if (decision.kind === "submit") {
        const hold = await this.options.holdReason?.().catch((cause) => `总控读取失败：${message(cause)}`);
        if (hold) { this.setStatus("held", `${hold}——生产线不提交新任务（已在 ComfyUI 的继续）`); return; }
      }
      if (decision.kind === "wait") {
        const labels = { in_flight: "有生产任务正在执行", comfy_busy: "ComfyUI 正在处理画布或其他任务，生产线等它空闲（不抢 GPU）", idle: "空闲", paused: "有剧集已暂停" };
        this.setStatus(decision.reason, labels[decision.reason]);
        return;
      }
      await this.submit(this.require(decision.episodeId), decision.task);
    } catch (cause) {
      this.setStatus("error", message(cause));
      this.report(`执行循环出错：${message(cause)}`);
    } finally { this.ticking = false; }
  }

  private async uploadInput(episode: Episode, name: string) {
    const data = await readFile(this.store.inputPath(episode.episodeId, name));
    const extension = name.slice(name.lastIndexOf("."));
    return this.comfy.uploadImage(new Uint8Array(data), `production_${episode.episodeId}_${randomBytes(4).toString("hex")}${extension}`);
  }

  private async buildGraph(episode: Episode, shot: ShotSpec, task: Task) {
    if (task.stage === "keyframe") {
      const inputs = keyframeInputs(episode, shot);
      return buildKeyframeGraph(episode, shot, task, { storyboard: inputs.storyboard ? await this.uploadInput(episode, inputs.storyboard) : null, face: inputs.face ? await this.uploadInput(episode, inputs.face) : null });
    }
    const source = episode.versions.find((version) => version.versionId === task.sourceVersionId);
    if (!source || source.status !== "approved") throw new Error("这条视频依赖的关键帧已不是通过状态，任务取消");
    const keyframeData = new Uint8Array(await readFile(this.store.resolve(episode.episodeId, source.file)));
    const size = pngSize(keyframeData) ?? { width: 864, height: 1536 };
    const plan = planVideoSubmission(episode, shot);
    const upload = async (key: string) => {
      const target = refTarget(key);
      return target.kind === "keyframe" ? this.comfy.uploadImage(keyframeData, `production_${episode.episodeId}_kf_${randomBytes(4).toString("hex")}.png`) : this.uploadInput(episode, target.name);
    };
    const images: string[] = []; const audios: string[] = [];
    for (const key of plan.images) images.push(await upload(key));
    for (const key of plan.audios) audios.push(await upload(key));
    return buildVideoGraph(episode, shot, task, plan, { images, audios }, size);
  }

  private async submit(episode: Episode, task: Task) {
    const shot = episode.shots.find((item) => item.shotId === task.shotId);
    if (!shot) { task.state = "cancelled"; task.error = "镜头已从剧集里删除"; await this.persist(episode); return; }
    this.setStatus("submitting", `${episode.title} · ${shot.shotId} · ${task.stage === "keyframe" ? "关键帧" : "视频"}`);
    let graph: unknown;
    this.preparing = { episodeId: episode.episodeId, shotId: shot.shotId };
    try {
      await this.options.beforeSubmit?.();
      graph = await this.buildGraph(episode, shot, task);
    } catch (cause) {
      this.preparing = null;
      // Nothing reached /prompt: uploads or graph building failed, or the thermal guard said no.
      if ((cause as { code?: string }).code === "GPU_THERMAL_BLOCKED") { this.setStatus("thermal", message(cause)); return; }
      task.state = "failed"; task.error = `准备失败：${message(cause)}`; task.completedAt = this.iso();
      this.note(episode, "prepare_failed", { shotId: shot.shotId, taskId: task.taskId, detail: task.error });
      await this.persist(episode);
      return;
    }
    this.preparing = null;
    // Deleted (episode or shot) or cancelled while uploading: never send it to the GPU.
    if (this.deleted.has(episode.episodeId) || !episode.shots.some((item) => item.shotId === task.shotId) || task.state !== "pending") {
      if (task.state === "pending") { task.state = "cancelled"; task.error = "准备期间镜头或剧集被删除，没有提交"; task.completedAt = this.iso(); }
      if (!this.deleted.has(episode.episodeId)) await this.persist(episode);
      return;
    }
    const promptId = randomUUID();
    const at = this.iso();
    task.attempts.push({ promptId, reservedAt: at, acceptedAt: null, outcome: "reserved", error: null });
    task.state = "reserved"; task.startedAt ??= at; task.error = null;
    // The reservation is on disk before /prompt: after any interruption the prompt is found again by this id.
    await this.persist(episode);
    const attempt = task.attempts.at(-1)!;
    try {
      await this.comfy.submit(graph, promptId);
      attempt.outcome = "accepted"; attempt.acceptedAt = this.iso();
      task.state = "queued";
      this.lastStage = task.stage;
      this.note(episode, "submitted", { shotId: shot.shotId, taskId: task.taskId, detail: promptId });
    } catch (cause) {
      attempt.error = message(cause);
      if (cause instanceof SubmissionNotSent) {
        attempt.outcome = "not_sent";
        if (task.retries < MAX_NOT_SENT_RETRIES) { task.retries += 1; task.state = "pending"; }
        else { task.state = "failed"; task.error = "ComfyUI 多次拒绝连接"; task.completedAt = this.iso(); }
      } else if (cause instanceof SubmissionUncertain) {
        // Stay "reserved": advance() looks the prompt_id up and never resubmits on doubt.
        this.note(episode, "submit_uncertain", { shotId: shot.shotId, taskId: task.taskId, detail: attempt.error });
      } else {
        attempt.outcome = "failed"; task.state = "failed"; task.error = `ComfyUI 拒绝：${attempt.error}`; task.completedAt = this.iso();
        this.note(episode, "rejected", { shotId: shot.shotId, taskId: task.taskId, detail: attempt.error });
      }
    }
    await this.persist(episode);
  }

  private async advance(episode: Episode, task: Task) {
    const attempt = task.attempts.at(-1);
    if (!attempt) { task.state = "pending"; await this.persist(episode); return; }
    let probe: ProductionProbe;
    try { probe = await this.comfy.probe(attempt.promptId); }
    catch { this.setStatus("offline", "ComfyUI 未连接，等待重连（不会重新提交）"); return; }
    if (probe.state !== "not_found") attempt.misses = 0;
    if (probe.state === "queued" || probe.state === "running") {
      if (task.state === "reserved") { attempt.outcome = "accepted"; attempt.acceptedAt ??= this.iso(); }
      if (task.state !== probe.state) { task.state = probe.state; await this.persist(episode); }
      this.setStatus(probe.state, `${episode.title} · ${task.shotId} · ${task.stage === "keyframe" ? "关键帧" : "视频"}`);
      return;
    }
    if (probe.state === "not_found") {
      // One miss can be a race (ComfyUI between queue and history); two consecutive polls decide.
      attempt.misses = (attempt.misses ?? 0) + 1;
      if (attempt.misses < 2) { await this.persist(episode); return; }
      // RISK: not in queue or history never proves it was not received. Pause this episode for the user.
      attempt.outcome = "lost";
      task.state = "needs_confirmation";
      task.error = `ComfyUI 的队列和历史里都找不到任务 ${attempt.promptId}（ComfyUI 可能重启过）。为避免重复生成已暂停这一集，请确认后选择重试或放弃。`;
      this.note(episode, "needs_confirmation", { shotId: task.shotId, taskId: task.taskId, detail: attempt.promptId });
      await this.persist(episode);
      return;
    }
    if (probe.state === "failed") {
      attempt.outcome = "failed"; task.state = "failed"; task.error = probe.error; task.completedAt = this.iso();
      this.note(episode, "failed", { shotId: task.shotId, taskId: task.taskId, detail: probe.error });
      await this.persist(episode);
      return;
    }
    if (probe.state !== "completed") return;
    const outputs = probe.outputs;
    task.state = "fetching";
    await this.persist(episode);
    try {
      const version = await this.collect(episode, task, outputs);
      attempt.outcome = "completed"; task.state = "completed"; task.completedAt = this.iso(); task.versionId = version.versionId;
      episode.versions.push(version);
      this.note(episode, "completed", { shotId: task.shotId, taskId: task.taskId, detail: version.file });
      await this.persist(episode);
      this.queueCheck(episode, version);
    } catch (cause) {
      // Output exists in ComfyUI; keep "fetching" and try again next tick — a few times, then report it.
      attempt.fetchFailures = (attempt.fetchFailures ?? 0) + 1;
      if (attempt.fetchFailures >= 5) {
        task.state = "failed"; task.error = `ComfyUI 已出结果，但取回 5 次都失败：${message(cause)}（文件可能还在 ComfyUI 的 output 里）`; task.completedAt = this.iso();
        this.note(episode, "fetch_failed", { shotId: task.shotId, taskId: task.taskId, detail: task.error });
      } else this.setStatus("fetching", `取回结果失败，稍后再试：${message(cause)}`);
      await this.persist(episode);
    }
  }

  private async collect(episode: Episode, task: Task, outputs: Record<string, ComfyOutputFile[]>): Promise<Version> {
    const base = `${task.shotId}_${task.taskId}`;
    const extra: Record<string, string> = {};
    let file: string;
    if (task.stage === "keyframe") {
      const image = outputs[KEYFRAME_SAVE_NODE]?.[0];
      if (!image) throw new Error("ComfyUI 已结束，但没有关键帧图片输出");
      const target = join(this.store.episodeDir(episode.episodeId), "keyframes", `${base}.png`);
      await this.store.atomicWrite(target, await this.comfy.download(image));
      file = this.store.relative(episode.episodeId, target);
      const depth = outputs[KEYFRAME_DEPTH_NODE]?.[0];
      if (depth) {
        const depthTarget = join(this.store.episodeDir(episode.episodeId), "keyframes", `${base}_depth.png`);
        await this.store.atomicWrite(depthTarget, await this.comfy.download(depth));
        extra.depth = this.store.relative(episode.episodeId, depthTarget);
      }
    } else {
      const videos = (outputs[VIDEO_SAVE_NODE] ?? []).filter((item) => item.filename.toLowerCase().endsWith(".mp4"));
      const pick = (episode.video.soundMode !== "silent" ? videos.find((item) => /-audio\.mp4$/i.test(item.filename)) : undefined) ?? videos[0];
      if (!pick) throw new Error("ComfyUI 已结束，但没有 MP4 输出");
      const target = join(this.store.episodeDir(episode.episodeId), "videos", `${base}.mp4`);
      await this.store.atomicWrite(target, await this.comfy.download(pick));
      file = this.store.relative(episode.episodeId, target);
    }
    return { versionId: `v-${randomBytes(6).toString("hex")}`, stage: task.stage, shotId: task.shotId, taskId: task.taskId, file, ...(Object.keys(extra).length ? { extra } : {}), seed: task.seed, status: "candidate", score: null, createdAt: this.iso(), decidedAt: null, note: "" };
  }

  /** Resolves once a running tick has finished (tests). */
  async whenIdle() { while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 10)); }

  /** Resolves when queued automatic checks have finished (tests, shutdown). */
  async checksSettled() { await this.checking; }

  /** Checks run one at a time on the CPU, after the result is safely on disk. */
  private queueCheck(episode: Episode, version: Version) {
    this.checking = this.checking.then(() => this.check(episode, version)).catch((cause) => this.report(`自动检查出错：${message(cause)}`));
  }

  private async check(episode: Episode, version: Version) {
    const shot = episode.shots.find((item) => item.shotId === version.shotId);
    const path = this.store.resolve(episode.episodeId, version.file);
    const score: Version["score"] = { checkedAt: this.iso() };
    try {
      if (version.stage === "keyframe") {
        const face = shot?.faceRole ? episode.roles.find((role) => role.key === shot.faceRole)?.face : null;
        if (face) {
          const result = lastJson<{ results: { face: number | null; faces: number; error?: string }[]; error?: string }>(await this.exec([this.options.checksScript, "face", this.store.inputPath(episode.episodeId, face), path], 180_000));
          if (result.error) score.error = result.error;
          const first = result.results[0];
          score.face = first?.face ?? null; score.faces = first?.faces ?? 0;
          score.problems = [];
          if (first?.faces === 0) score.problems.push("没有检测到人脸");
          if (first && first.faces > 1) score.problems.push(`检测到 ${first.faces} 张脸`);
          if (typeof first?.face === "number" && first.face < 0.45) score.problems.push("和角色脸差别较大");
        } else score.problems = [];
      } else {
        const result = lastJson<{ duration: number; hasAudio: boolean; blackFrames: number; frozenRatio: number; problems: string[] }>(await this.exec([this.options.checksScript, "video", path, String(shot?.seconds ?? 0)], 300_000));
        Object.assign(score, result);
        if (episode.video.soundMode === "av" && !result.hasAudio) score.problems = [...(score.problems ?? []), "要求有声，但视频没有音轨"];
      }
    } catch (cause) { score.error = message(cause).slice(0, 400); }
    const live = this.episodes.get(episode.episodeId);
    const target = live?.versions.find((item) => item.versionId === version.versionId);
    if (!live || !target) return;
    target.score = score;
    autoApproveKeyframes(live, this.iso()).forEach((approved) => this.note(live, "auto_approved", { shotId: approved.shotId, detail: approved.note }));
    await this.persist(live);
  }

  // ───────────────────────────── assembly ─────────────────────────────

  /** Approved video of every shot, in shot order, joined with hard cuts by the existing PyAV rough-cut script. */
  async assemble(id: string, options: { partial?: boolean } = {}) {
    this.requireOwner();
    const episode = this.require(id);
    if (this.assembling.has(id)) throw new Error("这一集正在合成");
    const videos = (shotId: string) => episode.versions.filter((item) => item.shotId === shotId && item.stage === "video");
    // Rough cut (partial): shot order; the chosen video, else the newest candidate; shots without a video are skipped.
    const pick = (shotId: string) => videos(shotId).find((item) => item.status === "approved") ?? (options.partial ? videos(shotId).filter((item) => item.status === "candidate").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined);
    const all = episode.shots.map((shot) => ({ shot, version: pick(shot.shotId) }));
    const missing = all.filter((clip) => !clip.version).map((clip) => clip.shot.shotId);
    if (missing.length && !options.partial) throw new Error(`这些镜头还没有选定视频：${missing.join("、")}`);
    const clips = all.filter((clip) => clip.version);
    if (!clips.length) throw new Error("还没有任何一镜出了视频");
    const unchosen = clips.filter((clip) => clip.version!.status !== "approved").map((clip) => clip.shot.shotId);
    this.assembling.add(id);
    try {
      const dir = join(this.store.episodeDir(id), "output");
      const stamp = this.iso().replace(/[-:]/g, "").replace(/\..+/, "");
      const planPath = join(dir, `plan_${stamp}.json`);
      const output = join(dir, `${episode.title.replace(/[\\/:*?"<>|]/g, "_")}_${stamp}.mp4`);
      const plan = { sizePolicy: "first", clips: [] as { source: string; inPoint: number; outPoint: number; title: string; filename: string }[] };
      for (const { shot, version } of clips) {
        const source = this.store.resolve(id, version!.file);
        if (!(await stat(source).catch(() => null))?.size) throw new Error(`${shot.shotId} 的视频文件不见了：${version!.file}`);
        // The rough-cut script rejects an out point past the real end (0.25 s tolerance), and H3 aligns
        // lengths to its 17k+5 frame grid — so use the measured duration, measuring now if needed.
        let duration = version!.score?.duration;
        if (typeof duration !== "number" || !(duration > 0)) {
          const probe = lastJson<{ duration: number }>(await this.exec([this.options.checksScript, "video", source, String(shot.seconds)], 300_000));
          duration = probe.duration;
        }
        if (!(duration > 0)) throw new Error(`${shot.shotId} 读不出视频时长`);
        plan.clips.push({ source, inPoint: 0, outPoint: duration, title: shot.title, filename: version!.file });
      }
      await this.store.atomicWrite(planPath, JSON.stringify(plan, null, 2));
      this.note(episode, "assemble_started", { detail: `${plan.clips.length} 镜` });
      await this.persist(episode);
      await this.exec([this.options.roughCutScript, "render", planPath, output], 60 * 60_000);
      this.note(episode, "assembled", { detail: this.store.relative(id, output) });
      await this.persist(episode);
      return { file: this.store.relative(id, output), clips: clips.length, skipped: missing, unchosen };
    } finally { this.assembling.delete(id); }
  }

  async mediaPath(id: string, file: string) {
    this.require(id);
    return this.store.resolve(id, file);
  }
}
