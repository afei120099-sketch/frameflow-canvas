import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Phase 19: local rough-cut jobs. One job = one temp folder under the system temp directory
 * ("frameflow-roughcut-*") holding the uploaded source videos, plan.json and output.mp4. The PyAV
 * helper only reads sources and writes output.mp4 there; the folder is removed on dispose, cancel,
 * failure cleanup or expiry. Nothing here touches ComfyUI, the project, or the browser's stores.
 */

export type RoughCutSizePolicy = "first" | "largest" | "1920x1080" | "1280x720" | "1080x1920" | "720x1280" | "1080x1080";
export const ROUGH_CUT_SIZE_POLICIES: readonly RoughCutSizePolicy[] = ["first", "largest", "1920x1080", "1280x720", "1080x1920", "720x1280", "1080x1080"];

export interface RoughCutClipInput { transition?: {type:"cut"|"dissolve"|"fade";seconds:number}; key: string; inPoint: number; outPoint: number; title: string; filename: string; audioSourceKey?: string; audioInPoint?: number }
export interface RoughCutError { code: string; message: string; clip: number | null; stage: string | null; detail?: string | null; filename?: string | null; logPath?: string }
export interface RoughCutStage { stage: "upload" | "probe" | "clip" | "finalize"; index?: number; total?: number; title?: string }
export type RoughCutState = "uploading" | "ready" | "running" | "done" | "failed" | "cancelled";
export interface RoughCutStatus { id: string; state: RoughCutState; stage: RoughCutStage | null; error: RoughCutError | null; result: Record<string, unknown> | null; scriptVersion: string; createdAt: number }

interface Job extends RoughCutStatus { touchedAt: number; dir: string; clips: RoughCutClipInput[]; keys: Set<string>; uploaded: Set<string>; child: ChildProcess | null; bytes: number }

const PREFIX = "frameflow-roughcut-";
const KEY = /^[A-Za-z0-9_-]{1,80}$/;

export interface RoughCutJobOptions {
  python: string;
  script: string;
  tempRoot?: string;
  maxSourceBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  /** Jobs untouched for this long are removed (their child killed) on the next call. */
  expireMs?: number;
}

export class RoughCutJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly options: Required<RoughCutJobOptions>;
  private scriptVersion: string | null = null;

  constructor(options: RoughCutJobOptions) {
    this.options = { tempRoot: tmpdir(), maxSourceBytes: 4 * 1024 ** 3, maxTotalBytes: 16 * 1024 ** 3, timeoutMs: 60 * 60_000, expireMs: 3 * 60 * 60_000, ...options };
  }

  /** sha256 of the PyAV helper, recorded on the Run as its "template" identity. */
  async version() {
    if (!this.scriptVersion) this.scriptVersion = `sha256:${createHash("sha256").update(await readFile(this.options.script)).digest("hex")}`;
    return this.scriptVersion;
  }

  async create(clips: RoughCutClipInput[]) {
    await this.expire();
    if (!Array.isArray(clips) || !clips.length) throw codeError("EMPTY_PLAN", "没有可输出的片段");
    if (clips.length > 500) throw codeError("TOO_MANY_CLIPS", "片段数量超过 500");
    for (const [index, clip] of clips.entries()) {
      if (clip.transition && (!["cut","dissolve","fade"].includes(clip.transition.type)||!Number.isFinite(clip.transition.seconds)||clip.transition.seconds<.05||clip.transition.seconds>1)) throw codeError("INVALID_TRANSITION","转场必须为 cut / dissolve / fade，时长0.05～1秒");
      if (!KEY.test(String(clip.key))) throw codeError("INVALID_SOURCE", `第 ${index + 1} 段素材标识无效`);
      if (clip.audioSourceKey !== undefined && (!KEY.test(clip.audioSourceKey) || typeof clip.audioInPoint !== 'number' || !Number.isFinite(clip.audioInPoint) || clip.audioInPoint < 0)) throw codeError('INVALID_SOURCE','原音轨来源或时间无效');
      if (![clip.inPoint, clip.outPoint].every((value) => typeof value === "number" && Number.isFinite(value)) || clip.inPoint < 0 || clip.outPoint <= clip.inPoint) throw codeError("INVALID_RANGE", `第 ${index + 1} 段入点 / 出点无效`);
    }
    const dir = await mkdtemp(join(this.options.tempRoot, PREFIX));
    const id = basename(dir).slice(PREFIX.length);
    const job: Job = { id, dir, state: "uploading", stage: null, error: null, result: null, scriptVersion: await this.version(), createdAt: Date.now(), touchedAt: Date.now(), clips: clips.map((clip) => ({ key: clip.key, ...(clip.audioSourceKey ? {audioSourceKey:clip.audioSourceKey,audioInPoint:clip.audioInPoint} : {}), inPoint: clip.inPoint, outPoint: clip.outPoint, transition:clip.transition, title: String(clip.title ?? "").slice(0, 200), filename: String(clip.filename ?? "").slice(0, 200) })), keys: new Set(clips.flatMap((clip) => [clip.key, ...(clip.audioSourceKey ? [clip.audioSourceKey] : [])])), uploaded: new Set(), child: null, bytes: 0 };
    this.jobs.set(id, job);
    return { id, sources: [...job.keys], scriptVersion: job.scriptVersion };
  }

  private job(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw codeError("JOB_NOT_FOUND", "粗剪任务已失联（服务进程重启或任务已释放），请重新准备；不会自动重剪");
    job.touchedAt = Date.now();
    return job;
  }

  /** Streams one source to disk (never buffered in memory). Each distinct Asset is uploaded once. */
  async writeSource(id: string, key: string, body: Readable) {
    const job = this.job(id);
    if (job.state !== "uploading") throw codeError("JOB_STATE", "任务已开始，不能再上传素材");
    if (!job.keys.has(key)) throw codeError("INVALID_SOURCE", "该素材不在本次粗剪中");
    let received = 0;
    const { maxSourceBytes, maxTotalBytes } = this.options;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      job.bytes += chunk.length;
      callback(received > maxSourceBytes || job.bytes > maxTotalBytes ? codeError("TOO_LARGE", "素材超过本地粗剪大小限制") : null, chunk);
    } });
    await pipeline(body, limiter, createWriteStream(this.sourcePath(job, key)));
    if (!received) throw codeError("EMPTY_SOURCE", "素材文件为空");
    job.uploaded.add(key);
    return { received };
  }

  private sourcePath(job: Job, key: string) { return join(job.dir, `source-${key}.bin`); }

  private async writePlan(job: Job, sizePolicy: RoughCutSizePolicy) {
    if (!ROUGH_CUT_SIZE_POLICIES.includes(sizePolicy)) throw codeError("INVALID_SIZE_POLICY", "未知输出尺寸");
    const missing = [...job.keys].filter((key) => !job.uploaded.has(key));
    if (missing.length) throw codeError("MISSING_SOURCE", `还有 ${missing.length} 个素材没有上传`);
    const plan = { sizePolicy, clips: job.clips.map((clip) => ({ source: this.sourcePath(job, clip.key), ...(clip.audioSourceKey ? {audioSource:this.sourcePath(job,clip.audioSourceKey),audioInPoint:clip.audioInPoint} : {}), inPoint: clip.inPoint, outPoint: clip.outPoint, transition:clip.transition, title: clip.title, filename: clip.filename })) };
    const path = join(job.dir, "plan.json");
    await writeFile(path, JSON.stringify(plan), "utf8");
    return path;
  }

  /** Real media info + the decided output spec (no encoding). */
  async plan(id: string, sizePolicy: RoughCutSizePolicy) {
    const job = this.job(id);
    const planPath = await this.writePlan(job, sizePolicy);
    const { stdout } = await this.exec(job, ["plan", planPath], 5 * 60_000);
    job.state = "ready";
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  async start(id: string, sizePolicy: RoughCutSizePolicy) {
    const job = this.job(id);
    if (job.state === "running") throw codeError("JOB_STATE", "粗剪已在进行");
    if (job.state === "done" || job.state === "cancelled") throw codeError("JOB_STATE", "该任务已结束，请重新准备");
    const planPath = await this.writePlan(job, sizePolicy);
    job.state = "running"; job.error = null; job.result = null; job.stage = { stage: "probe" };
    const output = join(job.dir, "output.mp4");
    const child = spawn(this.options.python, ["-X", "faulthandler", this.options.script, "render", planPath, output], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    job.child = child;
    let stdoutBuffer = ""; let stderr = "";
    const timer = setTimeout(() => { if (job.state === "running") { job.error = { code: "TIMEOUT", message: "粗剪超时", clip: null, stage: job.stage?.stage ?? null }; child.kill(); } }, this.options.timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim(); stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { event: string; result?: Record<string, unknown> } & RoughCutStage;
          if (event.event === "stage") job.stage = { stage: event.stage, index: event.index, total: event.total, title: event.title };
          else if (event.event === "done") job.result = event.result ?? null;
        } catch { /* ignore non-JSON output */ }
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-20_000); });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      job.child = null;
      if (job.state === "cancelled") return;
      if (code === 0 && job.result) { job.state = "done"; job.stage = null; return; }
      job.error = job.error ?? this.parseError(job, stderr, code);
      // Persist outside the disposable media folder; no source video copies are retained.
      try {
        const logDir=join(this.options.tempRoot,"frameflow-media-diagnostics");
        await mkdir(logDir,{recursive:true});
        const logPath=join(logDir,`${job.id}.json`);
        await writeFile(logPath,JSON.stringify({createdAt:job.createdAt,failedAt:Date.now(),exitCode:code,signal,scriptVersion:job.scriptVersion,stage:job.stage,error:job.error,stderr,clips:job.clips.map(({title,filename,inPoint,outPoint})=>({title,filename,inPoint,outPoint}))},null,2),"utf8");
        job.error.logPath=logPath;
      } catch { /* Reporting must still work when the diagnostic disk is unavailable. */ }
      if ((job as Job).state !== "cancelled") job.state = "failed";
      void rm(output, { force: true }).catch(() => {});
    });
    child.on("error", (cause) => { job.state = "failed"; job.error = { code: "PYAV_UNAVAILABLE", message: `本地 PyAV 运行环境无法启动：${cause.message}`, clip: null, stage: null }; });
    return this.status(id);
  }

  private parseError(job: Job, stderr: string, code: number | null): RoughCutError {
    const last = stderr.trim().split(/\r?\n/).at(-1) ?? "";
    try {
      const parsed = JSON.parse(last) as RoughCutError;
      if (parsed.code && parsed.message) return { ...parsed, filename: parsed.clip ? job.clips[parsed.clip - 1]?.filename ?? null : null };
    } catch { /* not a structured error */ }
    const hex=code===null?"unknown":`0x${(code>>>0).toString(16).toUpperCase()}`;
    const clip=job.stage?.index??null;
    return { code: "RENDER_FAILED", message: `本地视频处理异常退出（${hex}${hex==='0xC0000005'?' · 底层内存访问异常':''}）`, clip, filename:clip?job.clips[clip-1]?.filename??null:null, stage: job.stage?.stage ?? null, detail: stderr.trim().slice(-12_000) || null };
  }

  status(id: string): RoughCutStatus {
    const { state, stage, error, result, scriptVersion, createdAt } = this.job(id);
    return { id, state, stage, error, result, scriptVersion, createdAt };
  }

  async resultFile(id: string) {
    const job = this.job(id);
    if (job.state !== "done") throw codeError("JOB_STATE", "粗剪尚未完成");
    const path = join(job.dir, "output.mp4");
    return { path, size: (await stat(path)).size };
  }

  /** Stops the PyAV process (if any) and removes every temporary file. */
  async cancel(id: string, reason = "用户明确取消粗剪") {
    const job = this.jobs.get(id);
    if (!job) return;
    job.state = "cancelled";
    job.error = {code:"CANCELLED",message:reason,stage:job.stage?.stage??null,clip:job.stage?.index??null};
    try {
      const dir=join(this.options.tempRoot,"frameflow-media-diagnostics");await mkdir(dir,{recursive:true});
      const logPath=join(dir,`${id}-cancel.json`);
      await writeFile(logPath,JSON.stringify({id,at:Date.now(),reason,stage:job.stage,scriptVersion:job.scriptVersion},null,2),"utf8");
      job.error.logPath=logPath;
    } catch { /* Best effort; cancellation must not depend on log storage. */ }
    await this.stopChild(job);
    await removeJobDir(job.dir, this.options.tempRoot);
    // Keep the cancelled status until expiry so polling cannot mistake cancellation for loss.
  }

  async dispose(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.state === "running" || job.child) throw codeError("JOB_ACTIVE", "粗剪正在导出，禁止普通清理；如需停止请点击取消粗剪");
    await this.stopChild(job);
    this.jobs.delete(id);
    await removeJobDir(job.dir, this.options.tempRoot);
  }

  async disposeAll() { await Promise.all([...this.jobs.keys()].map(async id => { const job=this.jobs.get(id);if(job?.state==='running'||job?.child)await this.cancel(id,"任务管理器明确关闭");await this.dispose(id); })); }

  private async stopChild(job: Job) {
    const child = job.child;
    if (!child) return;
    await new Promise<void>((done) => { child.once("close", () => done()); child.kill(); setTimeout(done, 5_000); });
    job.child = null;
  }

  private async expire() {
    const now = Date.now();
    for (const job of [...this.jobs.values()]) if (job.state !== "running" && now - job.touchedAt > this.options.expireMs) await this.dispose(job.id);
    // Leftovers of a crashed dev server: old frameflow-roughcut-* folders nobody owns.
    const entries = await readdir(this.options.tempRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX) && !this.jobs.has(entry.name.slice(PREFIX.length))).map(async (entry) => {
      const path = join(this.options.tempRoot, entry.name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > this.options.expireMs) await removeJobDir(path, this.options.tempRoot);
    }));
  }

  private exec(job: Job, args: string[], timeout: number) {
    return new Promise<{ stdout: string }>((resolvePromise, reject) => {
      const child = spawn(this.options.python, [this.options.script, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let stdout = ""; let stderr = "";
      const timer = setTimeout(() => child.kill(), timeout);
      child.stdout!.on("data", (chunk) => { stdout += chunk; });
      child.stderr!.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
      child.on("error", (cause) => { clearTimeout(timer); reject(codeError("PYAV_UNAVAILABLE", `本地 PyAV 运行环境无法启动：${cause.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise({ stdout });
        else reject(Object.assign(new Error("plan failed"), { roughCut: this.parseError(job, stderr, code) }));
      });
    });
  }
}

/** Removes a job folder, but only one of ours directly inside the temp root. */
async function removeJobDir(dir: string, tempRoot: string) {
  if (dirname(resolve(dir)) !== resolve(tempRoot) || !basename(dir).startsWith(PREFIX)) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function codeError(code: string, message: string) {
  return Object.assign(new Error(message), { roughCut: { code, message, clip: null, stage: null } as RoughCutError });
}

