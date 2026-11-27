import assert from "node:assert/strict";
import { calculateWaveformPeaks, formatAudioTime, validAudioClip, WAVEFORM_BUCKETS } from "../lib/audio-waveform.ts";

const quietThenLoud = new Float32Array(800);
quietThenLoud.fill(0.1, 0, 400);
quietThenLoud.fill(0.8, 400);
const peaks = calculateWaveformPeaks([quietThenLoud], 8);
assert.equal(peaks.length, 8);
assert(peaks.slice(0, 4).every((peak) => Math.abs(peak - 0.1) < 1e-5));
assert(peaks.slice(4).every((peak) => Math.abs(peak - 0.8) < 1e-5));
assert.equal(calculateWaveformPeaks([quietThenLoud]).length, WAVEFORM_BUCKETS);
assert.deepEqual(calculateWaveformPeaks([new Float32Array(0)]), []);
assert.equal(formatAudioTime(64.85), "01:04.85");
assert(validAudioClip(1, 3, 8));
assert(!validAudioClip(1, 1.19, 8));
assert(!validAudioClip(-1, 2, 8));
assert(!validAudioClip(3, 9, 8));
console.log("Waveform derives from PCM amplitude; 256 display buckets, centisecond labels, clip bounds and 0.2s minimum passed");
