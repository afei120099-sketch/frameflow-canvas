export interface AudioProbe {
  hasAudio: boolean;
  duration: number;
  audioCodec: string | null;
  audioSampleRate: number | null;
}

async function checked(response: Response) {
  if (response.ok) return response;
  const payload = await response.json().catch(() => null) as { code?: string; message?: string } | null;
  throw new Error(payload?.message || `声音提取失败（HTTP ${response.status}）`);
}

export async function probeVideoAudio(video: Blob): Promise<AudioProbe> {
  const response = await checked(await fetch("/__audio_extract?operation=probe", { method: "POST", headers: { "Content-Type": "video/mp4" }, body: video }));
  return response.json();
}

export async function extractVideoAudio(video: Blob, range?: { start: number; end: number }): Promise<{ blob: Blob; duration: number }> {
  const query = new URLSearchParams({ operation: "extract" });
  if (range) { query.set("start", String(range.start)); query.set("end", String(range.end)); }
  const response = await checked(await fetch(`/__audio_extract?${query}`, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: video }));
  const duration = Number(response.headers.get("X-Audio-Duration"));
  const blob = await response.blob();
  if (!blob.size || !Number.isFinite(duration) || duration <= 0) throw new Error("提取结果不是有效声音文件");
  return { blob: blob.slice(0, blob.size, "audio/wav"), duration };
}

export async function clipAudioBlob(audio: Blob, start: number, end: number): Promise<{ blob: Blob; duration: number }> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error("声音裁剪范围无效");
  if (end - start < .2) throw new Error("选中的声音片段太短");
  const query = new URLSearchParams({ operation: "clip", start: String(start), end: String(end) });
  const response = await checked(await fetch(`/__audio_extract?${query}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: audio }));
  const duration = Number(response.headers.get("X-Audio-Duration"));
  const blob = await response.blob();
  if (!blob.size || !Number.isFinite(duration) || duration < .2) throw new Error("声音裁剪结果无效");
  return { blob: blob.slice(0, blob.size, "audio/wav"), duration };
}
