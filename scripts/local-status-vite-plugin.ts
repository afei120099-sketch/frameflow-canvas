import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import type { Plugin } from "vite";
import { thermalSafety } from "./gpu-thermal-vite-plugin";
import { PerformanceRecording, readPerformanceCounters } from "./performance-diagnosis";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
let previousCpu: { idle: number; total: number } | null = null;
let previousCores: { idle: number; total: number }[] = [];
function readCores() {
  const current = cpus().map(cpu => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, v) => sum + v, 0) }));
  const values = current.map((cpu, i) => { const last = previousCores[i]; return last && cpu.total > last.total ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - last.idle) / (cpu.total - last.total)))) : null; });
  previousCores = current;
  return values;
}
const smi = process.platform === "win32" && existsSync("C:/Windows/System32/nvidia-smi.exe") ? "C:/Windows/System32/nvidia-smi.exe" : "nvidia-smi";

function readCpuPercent() {
  const ticks = cpus().flatMap((cpu) => Object.entries(cpu.times));
  const current = { idle: ticks.filter(([kind]) => kind === "idle").reduce((sum, [, value]) => sum + value, 0), total: ticks.reduce((sum, [, value]) => sum + value, 0) };
  const last = previousCpu;
  previousCpu = current;
  if (!last || current.total <= last.total) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - (current.idle - last.idle) / (current.total - last.total)))));
}

async function readGpu() {
  try {
    const { stdout } = await execFileAsync(smi, ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"], { timeout: 1500, windowsHide: true });
    const [name, utilization, used, total, temperature] = stdout.trim().split(/\r?\n/)[0].split(",").map((part) => part.trim());
    const asNumber = (value: string) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
    return { name, utilizationPercent: asNumber(utilization), vramUsedBytes: asNumber(used) === null ? null : Number(used) * 1024 * 1024, vramTotalBytes: asNumber(total) === null ? null : Number(total) * 1024 * 1024, temperatureC: asNumber(temperature) };
  } catch { return null; }
}

export function localStatusPlugin(): Plugin {
  const recording = new PerformanceRecording();
  let recordingFile = '';
  let archiveError = '';
  const archive = async (value: unknown) => {
    if (!recordingFile) return;
    try { await appendFile(recordingFile, JSON.stringify(value) + '\n', 'utf8'); }
    catch { archiveError = '诊断日志落盘失败，请结束后导出记录。'; }
  };
  let sampling: Promise<void> | null = null;
  const sample = () => {
    if (sampling) return sampling;
    sampling = (async () => {
      const coreValues = readCores(), cpu = readCpuPercent(), ramTotal = totalmem(), ramUsed = ramTotal - freemem();
      const [windows, gpu] = await Promise.all([readPerformanceCounters(), readGpu()]);
      windows.metrics.cpuPercent = cpu;
      coreValues.forEach((v, i) => { windows.metrics[`cpuLogical${i}.busyPercent`] = v; });
      windows.metrics.ramPercent = 100 * ramUsed / ramTotal;
      windows.metrics.ramUsedGB = ramUsed / 1073741824;
      windows.metrics.gpuPercent = gpu?.utilizationPercent ?? null;
      windows.metrics.vramPercent = gpu?.vramTotalBytes && gpu.vramUsedBytes !== null ? 100 * gpu.vramUsedBytes / gpu.vramTotalBytes : null;
      windows.metrics.vramUsedGB = gpu?.vramUsedBytes === null || !gpu ? null : gpu.vramUsedBytes / 1073741824;
      windows.metrics.gpuTemperatureC = gpu?.temperatureC ?? null;
      try {
        const { stdout } = await execFileAsync(smi, ['--query-gpu=clocks.current.graphics,clocks.current.memory,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.hw_thermal_slowdown', '--format=csv,noheader,nounits'], { timeout: 1500, windowsHide: true });
        const [clock, memoryClock, sw, hw] = stdout.trim().split(/\r?\n/)[0].split(',').map(v => v.trim());
        windows.metrics.gpuClockMHz = Number.isFinite(Number(clock)) ? Number(clock) : null;
        windows.metrics.gpuMemoryClockMHz = Number.isFinite(Number(memoryClock)) ? Number(memoryClock) : null;
        windows.metrics.gpuThermalThrottlePercent = [sw, hw].some(v => v === 'Active') ? 100 : [sw, hw].every(v => v === 'Not Active') ? 0 : null;
      } catch { windows.metrics.gpuThermalThrottlePercent = null; windows.notes.push('GPU频率/热降频原因不可读，未知。'); }
      if (recording.status().recording) { recording.add(windows); await archive({ type: 'sample', ...windows }); }
    })().finally(() => { sampling = null; });
    return sampling;
  };
  return {
    name: "frameflow-local-system-status",
    configureServer(server) {
      const timer = setInterval(() => { if (recording.status().recording) void sample(); }, 10000);
      const cleanup = () => { clearInterval(timer); if (recording.status().recording) recording.endedAt = Date.now(); };
      server.httpServer?.once('close', cleanup);
      server.watcher.once('close', cleanup);
      server.middlewares.use("/__local_status", async (request, response) => {
        // This endpoint is for the desktop-only local dev server, never the hosted app.
        const remoteAddress = request.socket.remoteAddress ?? "";
        const host = request.headers.host ?? "";
        const origin = request.headers.origin;
        if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) || !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remoteAddress) || (origin && origin !== `http://${host}`)) { response.statusCode = 403; response.end(); return; }
        const url = new URL(request.url ?? '/', `http://${host}`);
        if (url.pathname === '/recording') {
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          try {
            if (request.method === 'POST') {
              const action = url.searchParams.get('action');
              if (action === 'start') {
                const task = url.searchParams.get('task') ?? '';
                if (!['A', 'B', 'C', 'D'].includes(task)) throw new Error('请选择A/B/C/D任务');
                if (recording.status().recording) throw new Error('已有诊断正在记录');
                const directory = join(server.config.root, 'runtime', 'performance');
                await mkdir(directory, { recursive: true });
                recordingFile = join(directory, `${Date.now()}-${randomUUID()}.jsonl`);
                archiveError = '';
                recording.start(task); await archive({ type: 'start', ...recording.status() }); void sample();
              } else if (action === 'stop') {
                // Do not count collection after the user's stop as task execution.
                recording.endedAt = Date.now();
                if (sampling) await sampling;
                await archive({ type: 'stop', ...recording.report() });
              } else throw new Error('未知操作');
            } else if (request.method !== 'GET') { response.statusCode = 405; response.end(); return; }
            response.end(JSON.stringify({ ...(request.method === 'GET' ? recording.report() : recording.status()), archiveError }));
          } catch (cause) { response.statusCode = 409; response.end(JSON.stringify({ error: cause instanceof Error ? cause.message : '诊断失败' })); }
          return;
        }
        if (request.method !== 'GET') { response.statusCode = 405; response.end(); return; }
        const ramTotalBytes = totalmem();
        const payload = { cpuPercent: recording.status().recording ? recording.samples.at(-1)?.metrics.cpuPercent ?? null : readCpuPercent(), ramUsedBytes: ramTotalBytes - freemem(), ramTotalBytes, gpu: await readGpu(), thermal: thermalSafety()?.status() ?? null, diagnosis: { ...recording.status(), archiveError } };
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(payload));
      });
    },
  };
}
