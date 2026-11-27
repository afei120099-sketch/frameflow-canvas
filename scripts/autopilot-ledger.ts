import { appendFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutopilotJob } from "../lib/autopilot.ts";

/**
 * Autopilot M1 on-disk ledger. Layout under the runtime root (default <project>/runtime/autopilot):
 *
 *   jobs/<jobId>.json          the job ledger (source of truth; atomically replaced on every change)
 *   <jobId>/autopilot.log      one JSON line per action (secrets redacted)
 *   <jobId>/shots/shot_NN.mp4  retrieved Shot videos
 *   <jobId>/output/…mp4        the rough cut
 *   worker.lock                which dev-server process runs the jobs
 *
 * Plain JSON files: no database, nothing in the browser's IndexedDB.
 */

export const JOB_ID_PATTERN = /^ap-\d{8}-\d{6}-[0-9a-f]{4}$/;

const SECRET_KEY = /(api[-_]?key|access[-_]?key|token|secret|password|passwd|authorization|cookie|credential)/i;

/** Drops secret-looking fields anywhere in a log entry; strips user:password@ from URLs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return value.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1");
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
    return out;
  }
  return value;
}

export interface AutopilotLogEntry {
  stage: "job" | "shot" | "rough_cut" | "recovery" | "service";
  action: string;
  shot?: number | null;
  runId?: string | null;
  promptId?: string | null;
  retry?: number;
  file?: string | null;
  error?: string | null;
  detail?: unknown;
}

export interface LockInfo { pid: number; instance: string; startedAt: string; heartbeat: string }

const RETRYABLE_FS = new Set(["EPERM", "EBUSY", "EACCES"]);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AutopilotStore {
  readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();
  private readonly logs = new Map<string, Promise<void>>();
  private sequence = 0;

  constructor(root: string) { this.root = root; }

  get jobsDir() { return join(this.root, "jobs"); }
  jobDir(jobId: string) { return join(this.root, jobId); }
  jobPath(jobId: string) { return join(this.jobsDir, `${jobId}.json`); }
  logPath(jobId: string) { return join(this.jobDir(jobId), "autopilot.log"); }
  get lockPath() { return join(this.root, "worker.lock"); }

  async init() {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(join(this.root, "work"), { recursive: true });
  }

  /**
   * Crash-safe replace: write a temp file, flush it to disk, then rename over the ledger. A crash
   * leaves either the old or the new complete file, never a half-written one. Writes of one job are
   * serialized so an older snapshot can never land after a newer one.
   */
  writeJob(job: AutopilotJob) {
    const text = `${JSON.stringify(job, null, 2)}\n`;
    const target = this.jobPath(job.jobId);
    const run = async () => { await this.atomicWrite(target, text); };
    const next = (this.writes.get(job.jobId) ?? Promise.resolve()).then(run, run);
    this.writes.set(job.jobId, next);
    void next.finally(() => { if (this.writes.get(job.jobId) === next) this.writes.delete(job.jobId); }).catch(() => {});
    return next;
  }

  async atomicWrite(target: string, data: string | Uint8Array) {
    const temp = `${target}.${process.pid}.${++this.sequence}.tmp`;
    const handle = await open(temp, "w");
    try { await (typeof data === "string" ? handle.writeFile(data, "utf8") : handle.writeFile(data)); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temp, target); return; }
      catch (cause) {
        // Windows: a reader (antivirus, indexer, the panel's GET) can hold the target for a moment.
        if (attempt < 8 && RETRYABLE_FS.has((cause as NodeJS.ErrnoException).code ?? "")) { await pause(25 * (attempt + 1)); continue; }
        await rm(temp, { force: true }).catch(() => {});
        throw cause;
      }
    }
  }

  async readJob(jobId: string): Promise<AutopilotJob | null> {
    try { return JSON.parse(await readFile(this.jobPath(jobId), "utf8")) as AutopilotJob; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
  }

  /** Every ledger on disk; unreadable files are reported, never deleted or "repaired". */
  async readAll() {
    const jobs: AutopilotJob[] = []; const damaged: { file: string; error: string }[] = [];
    const names = await readdir(this.jobsDir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json") || !JOB_ID_PATTERN.test(name.slice(0, -5))) continue;
      try {
        const job = JSON.parse(await readFile(join(this.jobsDir, name), "utf8")) as AutopilotJob;
        if (job?.schemaVersion !== 1 || job.jobId !== name.slice(0, -5)) throw new Error("不是 M1 任务账本");
        jobs.push(job);
      } catch (cause) { damaged.push({ file: name, error: cause instanceof Error ? cause.message : String(cause) }); }
    }
    return { jobs, damaged };
  }

  /** Appends one redacted JSON line; lines of one job stay in order. */
  appendLog(jobId: string, entry: AutopilotLogEntry, at = new Date()) {
    const line = `${JSON.stringify(redact({ time: at.toISOString(), ...entry }))}\n`;
    const run = async () => { await mkdir(this.jobDir(jobId), { recursive: true }); await appendFile(this.logPath(jobId), line, "utf8"); };
    const next = (this.logs.get(jobId) ?? Promise.resolve()).then(run, run);
    this.logs.set(jobId, next);
    void next.finally(() => { if (this.logs.get(jobId) === next) this.logs.delete(jobId); }).catch(() => {});
    return next;
  }

  async flush() { await Promise.allSettled([...this.writes.values(), ...this.logs.values()]); }

  // ——— one owner per runtime folder ———

  async readLock(): Promise<LockInfo | null> {
    try { return JSON.parse(await readFile(this.lockPath, "utf8")) as LockInfo; } catch { return null; }
  }

  /**
   * Takes the runtime folder for this process unless another live process holds it with a fresh
   * heartbeat. Two dev servers on one folder would otherwise both resume the same job.
   */
  async acquireLock(instance: string, staleMs: number): Promise<{ ok: true } | { ok: false; owner: LockInfo }> {
    const now = new Date().toISOString();
    const mine: LockInfo = { pid: process.pid, instance, startedAt: now, heartbeat: now };
    try {
      const handle = await open(this.lockPath, "wx");
      try { await handle.writeFile(JSON.stringify(mine)); } finally { await handle.close(); }
      return { ok: true };
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
    const owner = await this.readLock();
    const fresh = owner ? Date.now() - Date.parse(owner.heartbeat) < staleMs : false;
    if (owner && owner.instance !== instance && owner.pid !== process.pid && isAlive(owner.pid) && fresh) return { ok: false, owner };
    await this.atomicWrite(this.lockPath, JSON.stringify(mine));
    await pause(30);
    const check = await this.readLock();
    return check?.instance === instance ? { ok: true } : { ok: false, owner: check ?? mine };
  }

  async refreshLock(instance: string) {
    const current = await this.readLock();
    if (current?.instance !== instance) return false;
    await this.atomicWrite(this.lockPath, JSON.stringify({ ...current, heartbeat: new Date().toISOString() }));
    return true;
  }

  async releaseLock(instance: string) {
    const current = await this.readLock();
    if (current?.instance === instance) await rm(this.lockPath, { force: true }).catch(() => {});
  }

  /** Small helper for tests and tools: writes a raw ledger file as-is. */
  async writeRaw(jobId: string, value: unknown) { await writeFile(this.jobPath(jobId), JSON.stringify(value, null, 2), "utf8"); }
}

export function isAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
}
