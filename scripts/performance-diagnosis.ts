import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { summarizePerformance, type PerformanceSample } from '../lib/performance-diagnosis.ts';

const exec = promisify(execFile);
const WINDOWS_COUNTERS = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new();
function Read-Counter($class) { try { @(Get-CimInstance $class -ErrorAction Stop) } catch { @() } }
$disk=Read-Counter 'Win32_PerfFormattedData_PerfDisk_PhysicalDisk';
$memory=Read-Counter 'Win32_PerfFormattedData_PerfOS_Memory';
$page=Read-Counter 'Win32_PageFileUsage';
$engine=Read-Counter 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine';
@{disk=@($disk | Where-Object Name -ne '_Total' | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec,PercentIdleTime,AvgDisksecPerRead,AvgDisksecPerWrite); memory=@($memory | Select-Object CommittedBytes,CommitLimit,PagesInputPersec,PagesOutputPersec); page=@($page | Select-Object Name,AllocatedBaseSize,CurrentUsage); engine=@($engine | Select-Object Name,UtilizationPercentage)} | ConvertTo-Json -Depth 4 -Compress`;

export async function readPerformanceCounters(): Promise<PerformanceSample> {
  const metrics: Record<string, number | null> = { gpuComputePercent: null, gpu3DPercent: null, gpuVideoEncodePercent: null, gpuVideoDecodePercent: null, cpuTemperatureC: null, cpuThermalThrottlePercent: null };
  const notes = ['CPU温度和热降频：Windows通用接口未提供可靠传感器，未知；不能用低频率推断热降频。', 'GPU引擎来自WDDM；Compute/CUDA可能记在3D引擎，Compute缺失不能解释为零。', 'PagesInput/Output包含内存映射文件活动，不等于纯pagefile读写。'];
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_COUNTERS], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const raw = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    const engines = new Map<string, number>();
    for (const row of raw.engine ?? []) {
      const match = /luid_(.+)_phys_(\d+)_eng_(\d+)_engtype_(.+)$/.exec(row.Name);
      if (!match) continue;
      const key = `${match[1]}:${match[2]}:${match[3]}:${match[4]}`;
      engines.set(key, (engines.get(key) ?? 0) + Number(row.UtilizationPercentage));
    }
    for (const [type, key] of [['3D', 'gpu3DPercent'], ['Compute|CUDA', 'gpuComputePercent'], ['VideoEncode', 'gpuVideoEncodePercent'], ['VideoDecode', 'gpuVideoDecodePercent']]) {
      const values = [...engines].filter(([name]) => new RegExp(`:(${type})(?:_.*)?$`, 'i').test(name)).map(([, value]) => value);
      if (values.length) metrics[key] = Math.min(100, Math.max(...values));
    }
    for (const disk of raw.disk ?? []) {
      const prefix = `disk.${disk.Name}`;
      metrics[`${prefix}.readMBps`] = Number(disk.DiskReadBytesPersec) / 1048576;
      metrics[`${prefix}.writeMBps`] = Number(disk.DiskWriteBytesPersec) / 1048576;
      metrics[`${prefix}.activePercent`] = Math.max(0, Math.min(100, 100 - Number(disk.PercentIdleTime)));
      metrics[`${prefix}.readLatencyMs`] = Number(disk.AvgDisksecPerRead) * 1000;
      metrics[`${prefix}.writeLatencyMs`] = Number(disk.AvgDisksecPerWrite) * 1000;
    }
    const memory = raw.memory?.[0];
    if (memory) {
      metrics.commitPercent = Number(memory.CommitLimit) > 0 ? 100 * Number(memory.CommittedBytes) / Number(memory.CommitLimit) : null;
      metrics.pagesInputPerSec = Number(memory.PagesInputPersec);
      metrics.pagesOutputPerSec = Number(memory.PagesOutputPersec);
    }
    const pages = raw.page ?? [];
    metrics.pagefileUsedMB = pages.length ? pages.reduce((s: number, p: { CurrentUsage: number }) => s + Number(p.CurrentUsage), 0) : null;
    const pageTotal = pages.reduce((s: number, p: { AllocatedBaseSize: number }) => s + Number(p.AllocatedBaseSize), 0);
    metrics.pagefilePercent = pageTotal ? 100 * (metrics.pagefileUsedMB ?? 0) / pageTotal : null;
    if (!raw.disk?.length || !memory) notes.push('部分Windows计数器不可用，缺失指标不可当作零。');
  } catch { notes.push('Windows性能计数器读取失败，本次磁盘、分页、GPU引擎数据缺失。'); }
  return { at: Date.now(), metrics, notes };
}

export class PerformanceRecording {
  task = '';
  startedAt = 0;
  endedAt: number | null = null;
  samples: PerformanceSample[] = [];
  start(task: string) {
    if (this.task && this.endedAt === null) throw new Error('已有诊断正在记录');
    this.task = task; this.startedAt = Date.now(); this.endedAt = null; this.samples = [];
  }
  add(sample: PerformanceSample) {
    if (this.task && this.endedAt === null) {
      if (this.samples.length >= 4320) { this.endedAt = Date.now(); return; }
      this.samples.push(sample);
    }
  }
  status() { return { task: this.task, recording: Boolean(this.task && this.endedAt === null), sampleCount: this.samples.length, startedAt: this.startedAt, endedAt: this.endedAt }; }
  report() { return { ...this.status(), summary: summarizePerformance(this.samples, this.endedAt ?? Date.now()), samples: this.samples }; }
}
