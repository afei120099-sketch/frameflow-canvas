"use client";

import { useEffect, useRef, useState } from "react";
import { startVisibleStatusPoll } from "@/lib/visible-status-poll";
import { comfyUIH3Adapter } from "@/lib/comfyui/h3-adapter";

type LocalStatus = { diagnosis?: { recording: boolean; task: string; sampleCount: number; archiveError?: string }; thermal?: import("@/lib/gpu-thermal-status").ThermalStatus | null; cpuPercent: number | null; ramUsedBytes: number; ramTotalBytes: number; gpu: { name: string; utilizationPercent: number | null; vramUsedBytes: number | null; vramTotalBytes: number | null; temperatureC: number | null } | null };
type ComfyStats = { system?: { ram_total?: number; ram_free?: number }; devices?: { name?: string; vram_total?: number; vram_free?: number }[] };
const gb = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1);

export function LocalSystemStatus() {
  const refreshStatus = useRef<(() => void) | null>(null);
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [comfy, setComfy] = useState<ComfyStats | null>(null);
  const [queueCount, setQueueCount] = useState<number | null>(null);
  const [thermalMessage, setThermalMessage] = useState("");
  const [resuming, setResuming] = useState(false);
  const resumeThermal = async () => {
    setResuming(true);
    try {
      const response = await fetch("/__thermal_safety/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
      const result = await response.json() as import("@/lib/gpu-thermal-status").ThermalStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "解除失败");
      setLocal((value) => value ? { ...value, thermal: result } : value);
      setThermalMessage("保护锁已解除；已停止的生成不会自动重跑，夜班需另行确认继续。");
    } catch (cause) { setThermalMessage(cause instanceof Error ? cause.message : "解除失败"); }
    finally { setResuming(false); }
  };
  const [open, setOpen] = useState(false);
  const [diagnosisTask, setDiagnosisTask] = useState('A');
  const [diagnosisMessage, setDiagnosisMessage] = useState('');
  const [diagnosisPending, setDiagnosisPending] = useState(false);
  const diagnose = async (action: 'start' | 'stop') => {
    setDiagnosisPending(true);
    try {
      const response = await fetch(`/__local_status/recording?action=${action}&task=${diagnosisTask}`, { method: 'POST', signal: AbortSignal.timeout(20000) });
      const status = await response.json() as NonNullable<LocalStatus['diagnosis']> & { error?: string };
      if (!response.ok) throw new Error(status.error ?? '诊断请求失败');
      setLocal(value => value ? { ...value, diagnosis: status } : value);
      setDiagnosisMessage(action === 'start' ? '已开始，每10秒采样；可切换到剪映，保持本地服务运行。' : '已结束，请导出记录后交给我分析。');
    } catch (cause) { setDiagnosisMessage(cause instanceof Error ? cause.message : '诊断失败'); }
    finally { setDiagnosisPending(false); }
  };
  const exportDiagnosis = async () => {
    try {
      const response = await fetch('/__local_status/recording', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('导出失败');
      const report = await response.json() as { task?: string } & Record<string, unknown>;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `Frameflow-性能诊断-${report.task || '未开始'}-${Date.now()}.json`;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setDiagnosisMessage(cause instanceof Error ? cause.message : '导出失败'); }
  };
  useEffect(() => {
    let active = true;
    const readJson = async (url: string) => { const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) }); if (!response.ok) throw new Error(String(response.status)); return response.json(); };
    const localPoll = startVisibleStatusPoll(async () => {
      try { const value = await readJson("/__local_status"); if (active) setLocal(value as LocalStatus); return true; }
      catch { if (active) setLocal(null); return false; }
    }, { document, window, delays: [2000] });
    const comfyPoll = startVisibleStatusPoll(async () => {
      // One health request while offline: do not emit a second identical proxy failure for /queue.
      // Reads go through the adapter's shared cache, so node availability probes reuse the same request.
      let stats: ComfyStats;
      try { stats = await comfyUIH3Adapter.systemStats<ComfyStats>(); }
      catch { if (active) { setComfy(null); setQueueCount(null); } return false; }
      if (!active) return false;
      setComfy(stats);
      try {
        const queue = await comfyUIH3Adapter.queueSnapshot();
        if (active) setQueueCount((queue.queue_running?.length ?? 0) + (queue.queue_pending?.length ?? 0));
        return true;
      } catch { if (active) setQueueCount(null); return false; }
    }, { document, window, delays: [5000, 15000, 30000] });
    refreshStatus.current = () => { localPoll.refresh(); comfyPoll.refresh(); };
    return () => {
      active = false; refreshStatus.current = null; localPoll.stop(); comfyPoll.stop();
    };
  }, []);
  const device = comfy?.devices?.[0];
  const vramTotal = device?.vram_total ?? local?.gpu?.vramTotalBytes ?? null;
  const vramUsed = device?.vram_total !== undefined && device.vram_free !== undefined ? device.vram_total - device.vram_free : local?.gpu?.vramUsedBytes ?? null;
  const ramTotal = comfy?.system?.ram_total ?? local?.ramTotalBytes ?? null;
  const ramUsed = comfy?.system?.ram_total !== undefined && comfy.system.ram_free !== undefined ? comfy.system.ram_total - comfy.system.ram_free : local?.ramUsedBytes ?? null;
  const pressure = vramTotal && vramUsed !== null ? vramUsed / vramTotal : 0;
  return <div className="system-status-wrap">
    {(local?.thermal?.blocked || thermalMessage) && <div className="thermal-notice" role="status"><span>{local?.thermal?.blocked ? local.thermal.reason : thermalMessage}</span>{local?.thermal?.latched && <button type="button" disabled={!local.thermal.canResume || resuming} onClick={() => { void resumeThermal(); }}>手动解除保护</button>}{local?.thermal?.blocked && thermalMessage && <span>{thermalMessage}</span>}<small className="ff-hint">仅保护本地 ComfyUI GPU 任务；本地服务需保持运行。</small></div>}
    <button type="button" className={`system-status ${pressure >= .9 ? "pressure-high" : pressure >= .8 ? "pressure-warn" : ""}`} title="查看本机运行状态" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
    <span className="metric metric-vram">VRAM {vramUsed !== null && vramTotal ? `${gb(vramUsed)}/${gb(vramTotal)}GB` : "—"}</span>
    <span className="metric metric-gpu">GPU {local?.gpu?.utilizationPercent ?? "—"}%</span>
    <span className={`metric ${local?.thermal?.blocked ? "thermal-blocked" : ""}`}>温度 {local?.thermal?.temperatureC ?? "—"}°C · {local?.thermal ? local.thermal.blocked ? "保护暂停" : "保护中" : "保护未知"}</span>
    <span className="metric metric-ram">RAM {ramUsed !== null && ramTotal ? `${gb(ramUsed)}/${gb(ramTotal)}GB` : "—"}</span>
    <span className="metric metric-cpu">CPU {local?.cpuPercent ?? "—"}%</span>
    <span className={`metric metric-comfy ${comfy ? "connected" : "disconnected"}`}>ComfyUI ●</span>
  </button>{open && <div className="system-status-detail"><b>本机运行状态</b><span>{local?.gpu?.name ?? device?.name ?? "GPU 型号未知"}</span><span>GPU 利用率：{local?.gpu?.utilizationPercent ?? "—"}%</span><span>显存：{vramUsed !== null && vramTotal ? `${gb(vramUsed)} / ${gb(vramTotal)} GB` : "未知"}</span>{local?.gpu?.temperatureC !== null && local?.gpu?.temperatureC !== undefined && <span>GPU 温度：{local.gpu.temperatureC}°C</span>}<span>内存：{ramUsed !== null && ramTotal ? `${gb(ramUsed)} / ${gb(ramTotal)} GB` : "未知"}</span><span>CPU 利用率：{local?.cpuPercent ?? "—"}%</span><span>ComfyUI：{comfy ? "已连接" : "未连接"}</span>{queueCount !== null && <span>当前队列：{queueCount}</span>}
    <button type="button" onClick={() => refreshStatus.current?.()}>立即检查连接</button>
    <b>任务性能诊断</b>
    <select aria-label="诊断任务" value={diagnosisTask} disabled={local?.diagnosis?.recording || diagnosisPending} onChange={event => setDiagnosisTask(event.target.value)}><option value="A">A · AI视频生成</option><option value="B">B · 剪映导出</option><option value="C">C · 插帧 / 高清修复</option><option value="D">D · ComfyUI / 本地模型</option></select>
    <div><button type="button" disabled={!local || diagnosisPending} onClick={() => void diagnose(local?.diagnosis?.recording ? 'stop' : 'start')}>{local?.diagnosis?.recording ? '结束诊断' : '开始诊断'}</button> <button type="button" disabled={!local?.diagnosis?.sampleCount || diagnosisPending} onClick={() => void exportDiagnosis()}>导出记录</button></div>
    <span>{local?.diagnosis?.recording ? `记录中 · ${local.diagnosis.task} · ${local.diagnosis.sampleCount}个采样` : diagnosisMessage || '只记录资源，不启动任务、不修改设置。'}</span>
    {local?.diagnosis?.archiveError && <span>{local.diagnosis.archiveError}</span>}
    <small className="ff-hint">10秒采样，自动保存本地日志。CPU温度未知；缺失数据不计为0。结束并导出后再开始下一项。</small>
  </div>}</div>;
}
