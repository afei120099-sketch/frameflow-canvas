import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThermalStatus } from "../lib/gpu-thermal-status.ts";

const exec = promisify(execFile);
export const GPU_STOP_C = 80;
export const GPU_RESUME_BELOW_C = 75;
export class ThermalBlockedError extends Error {
  readonly code = "GPU_THERMAL_BLOCKED";
}
export function parseGpuTemperatures(text: string): number | null {
  const lines = text.trim().split(/\r?\n/);
  if (lines.some((line) => !/^\d+(\.\d+)?$/.test(line.trim()))) return null;
  const values = lines.map(Number);
  return values.every((value) => value > 0 && value < 150) ? Math.max(...values) : null;
}
export async function readGpuTemperature() {
  try {
    const { stdout } = await exec("nvidia-smi", ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"], { timeout: 1500, windowsHide: true });
    return parseGpuTemperatures(stdout);
  } catch { return null; }
}

/** Server-side, fail-closed dispatch gate. A cooling GPU never automatically clears a trip. */
export class GpuThermalSafety {
  private temperatureC: number | null = null;
  private latched = false;
  private stopConfirmed = false;
  private reason = "正在读取 GPU 温度，暂不放行新任务";
  private storageError = false;
  private resuming = false;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly ready: Promise<void>;
  private readonly options: { file: string; readTemperature: () => Promise<number | null>; stopComfy: () => Promise<boolean> };
  constructor(options: { file: string; readTemperature: () => Promise<number | null>; stopComfy: () => Promise<boolean> }) {
    this.options = options;
    this.ready = this.load();
  }
  private async load() {
    try {
      const saved = JSON.parse(await readFile(this.options.file, "utf8"));
      if (typeof saved.latched !== "boolean") throw new Error("保护记录损坏");
      this.latched = saved.latched;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.latched = true;
    }
  }
  private async persist(latched = this.latched) {
    try {
      await mkdir(dirname(this.options.file), { recursive: true });
      const temp = `${this.options.file}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, latched }), "utf8");
      await rename(temp, this.options.file);
      this.storageError = false;
    } catch { this.storageError = true; throw new ThermalBlockedError("温度保护记录无法保存，已禁止新任务"); }
  }
  status(): ThermalStatus {
    const blocked = this.latched || this.temperatureC === null || this.storageError || this.resuming;
    return { temperatureC: this.temperatureC, latched: this.latched, blocked,
      canResume: this.latched && !this.storageError && this.stopConfirmed && this.temperatureC !== null && this.temperatureC < GPU_RESUME_BELOW_C,
      reason: this.reason, stopConfirmed: this.stopConfirmed };
  }
  sample() {
    if (this.pending) return this.pending;
    this.pending = this.check().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async check() {
    await this.ready;
    if (this.resuming) return;
    const temperature = await this.options.readTemperature().catch(() => null);
    this.temperatureC = temperature !== null && Number.isFinite(temperature) && temperature > 0 && temperature < 150 ? temperature : null;
    if (this.temperatureC !== null && this.temperatureC >= GPU_STOP_C) this.latched = true;
    if (this.latched) {
      // Persist before interruption; persistence failure must not prevent the safety stop.
      await this.persist().catch(() => {});
      this.stopConfirmed = await this.options.stopComfy().catch(() => false);
      this.reason = this.storageError ? "保护记录无法保存，禁止恢复" : this.stopConfirmed
        ? "过温保护已锁定；降到 75°C 以下后手动解除，不会自动重跑"
        : "过温保护已锁定，正在请求停止；尚未确认 ComfyUI 队列清空";
    } else this.reason = this.temperatureC === null ? "GPU 温度不可读，已禁止新任务" : "GPU 温度保护已启用（80°C 暂停）";
  }
  start() {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, 2000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; return this.pending ?? Promise.resolve(); }
  async assertCanSubmit() {
    await this.sample();
    if (this.status().blocked) throw new ThermalBlockedError(this.reason);
  }
  async resume() {
    await this.sample();
    if (!this.status().canResume) throw new ThermalBlockedError("不能解除：需 GPU 低于 75°C、队列停止并且保护记录可保存");
    if (this.resuming) throw new ThermalBlockedError("正在解除保护，请勿重复点击");
    this.resuming = true;
    try {
      // Keep the dispatch latch until the durable unlock succeeds; polling cannot overwrite it.
      await this.persist(false);
      this.latched = false;
      this.reason = "GPU 温度保护已启用（80°C 暂停）";
    } finally { this.resuming = false; }
  }
}
