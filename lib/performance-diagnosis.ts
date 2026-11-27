export type PerformanceSample = { at: number; metrics: Record<string, number | null>; notes: string[] };

// Durations use the previous valid sample, capped at two sampling intervals.
// Missing data never counts as idle, and long interruptions never count as load.
export function summarizePerformance(samples: PerformanceSample[], endedAt: number, intervalMs = 10000) {
  const keys = new Set(samples.flatMap(s => Object.keys(s.metrics)));
  const metrics: Record<string, { peak: number | null; average: number | null; validSamples: number; observedSeconds: number; highSeconds: number | null; longestHighSeconds: number | null; threshold: number | null }> = {};
  for (const key of keys) {
    const threshold = key.endsWith('Percent') ? 90 : null;
    let peak: number | null = null, sum = 0, seconds = 0, validSamples = 0, high = 0, streak = 0, longest = 0;
    samples.forEach((sample, i) => {
      const value = sample.metrics[key];
      const duration = Math.max(0, Math.min(intervalMs * 2, (samples[i + 1]?.at ?? endedAt) - sample.at)) / 1000;
      if (value === null || value === undefined || !Number.isFinite(value)) { streak = 0; return; }
      validSamples++; peak = peak === null ? value : Math.max(peak, value);
      sum += value * duration; seconds += duration;
      if (threshold !== null && value >= threshold) { high += duration; streak += duration; longest = Math.max(longest, streak); } else streak = 0;
      if (duration >= intervalMs * 2 / 1000) streak = 0;
    });
    metrics[key] = { peak, average: seconds ? sum / seconds : null, validSamples, observedSeconds: seconds, highSeconds: threshold === null ? null : high, longestHighSeconds: threshold === null ? null : longest, threshold };
  }
  return { durationSeconds: samples.length ? (endedAt - samples[0].at) / 1000 : 0, sampleCount: samples.length, intervalMs, metrics,
    notes: [...new Set(samples.flatMap(s => s.notes))], caveat: '10秒采样可能漏掉瞬时尖峰；90%为高占用统计门槛，不等于已确认瓶颈。温度/频率/吞吐需结合任务阶段分析。' };
}
