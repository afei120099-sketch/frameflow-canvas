import assert from 'node:assert/strict';
import { summarizePerformance } from '../lib/performance-diagnosis.ts';
import { PerformanceRecording, readPerformanceCounters } from './performance-diagnosis.ts';
const samples = [
  { at: 0, metrics: { cpuPercent: 95, missingPercent: null, readMBps: 10 }, notes: ['unknown'] },
  { at: 10000, metrics: { cpuPercent: 100, missingPercent: null, readMBps: 20 }, notes: ['unknown'] },
  { at: 20000, metrics: { cpuPercent: 50, missingPercent: null, readMBps: 0 }, notes: [] },
];
const summary = summarizePerformance(samples, 30000);
assert.equal(summary.metrics.cpuPercent.peak, 100);
assert.equal(summary.metrics.cpuPercent.average, 245 / 3);
assert.equal(summary.metrics.cpuPercent.highSeconds, 20);
assert.equal(summary.metrics.cpuPercent.longestHighSeconds, 20);
assert.equal(summary.metrics.missingPercent.average, null);
assert.equal(summary.metrics.missingPercent.validSamples, 0);
assert.equal(summary.metrics.readMBps.highSeconds, null);
assert.deepEqual(summary.notes, ['unknown']);
assert.equal(summarizePerformance([samples[0]], 100000).metrics.cpuPercent.highSeconds, 20, 'Long gaps must not invent sustained load');
const recording = new PerformanceRecording();
recording.start('A');
assert.throws(() => recording.start('B'));
recording.add(samples[0]);
recording.endedAt = Date.now();
recording.add(samples[1]);
assert.equal(recording.samples.length, 1);
recording.start('B');
assert.equal(recording.samples.length, 0);
if (process.argv.includes('--probe')) {
  const result = await readPerformanceCounters();
  assert.equal(result.metrics.cpuTemperatureC, null);
  assert.ok(Object.keys(result.metrics).some(k => k.includes('activePercent')), 'Live disk counters missing');
  console.log(JSON.stringify(result, null, 2));
}
console.log('Performance diagnosis: missing data, time-weighted mean, high duration, gap cap and recording lifecycle passed');
