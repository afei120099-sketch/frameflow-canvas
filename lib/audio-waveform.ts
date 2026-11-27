export const WAVEFORM_BUCKETS = 256;
export const MIN_AUDIO_CLIP_SECONDS = 0.2;

/** Display-only peaks. The PCM samples themselves are never stored on the node. */
export function calculateWaveformPeaks(channels: Float32Array[], count = WAVEFORM_BUCKETS): number[] {
  const length = channels[0]?.length ?? 0;
  if (!length || !channels.length || count < 1) return [];
  const peaks = new Array<number>(count).fill(0);
  for (let bucket = 0; bucket < count; bucket++) {
    const first = Math.floor(bucket * length / count);
    const last = Math.max(first + 1, Math.floor((bucket + 1) * length / count));
    let peak = 0;
    for (const channel of channels) {
      for (let sample = first; sample < Math.min(last, channel.length); sample++) peak = Math.max(peak, Math.abs(channel[sample]));
    }
    peaks[bucket] = Math.min(1, peak);
  }
  return peaks;
}

export function formatAudioTime(seconds: number) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(centiseconds / 6000);
  const remainder = centiseconds % 6000;
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(remainder / 100)).padStart(2, "0")}.${String(remainder % 100).padStart(2, "0")}`;
}

export function validAudioClip(start: number, end: number, duration: number) {
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(duration) && start >= 0 && end > start && end <= duration + .02 && end - start >= MIN_AUDIO_CLIP_SECONDS - 1e-6;
}
