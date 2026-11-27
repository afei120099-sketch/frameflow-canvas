import type { RunRecord } from "./production-records.ts";
import type { ReferenceManifest } from "./reference-manifest.ts";

/**
 * Human-readable "who is which number" for a Run, e.g.
 *   柴犬 → Picture 1 → Audio 2
 *   橘猫 → Picture 2
 *   首帧 frame.png → Picture 1
 * Derived from the frozen Reference Manifest (Ref2VA) or the recorded input order (I2VA / FL2VA);
 * nothing is stored twice and nothing is guessed beyond what the Run recorded.
 */

export interface MediaMapLine {
  /** Role name, frame name or file name. */
  subject: string;
  kind: "role" | "frame" | "asset";
  pictures: number[];
  videos: number[];
  audios: number[];
}

export interface RunMediaMap { lines: MediaMapLine[]; source: "manifest" | "input_order" | "none"; note: string | null }

const SOURCE_NAMES: Record<string, string> = { first_frame: "首帧", connected_reference: "连线参考图", reference_image: "参考图", role_appearance: "角色外观", reference_audio: "参考声音", role_voice: "角色声音" };

export function formatMediaLine(line: MediaMapLine) {
  const parts = [...line.pictures.map((n) => `Picture ${n}`), ...line.videos.map((n) => `Video ${n}`), ...line.audios.map((n) => `Audio ${n}`)];
  return [line.subject, ...parts].join(" → ");
}

export function manifestMediaMap(manifest: ReferenceManifest): MediaMapLine[] {
  const lines: MediaMapLine[] = [];
  const claimedPictures = new Set<number>();
  const claimedAudios = new Set<number>();
  for (const binding of manifest.roleBindings) {
    const pictures = manifest.pictureRefs.filter((ref) => ref.roleIds.includes(binding.roleId)).map((ref) => ref.index);
    const audios = manifest.audioRefs.filter((ref) => ref.roleIds.includes(binding.roleId)).map((ref) => ref.index);
    if (binding.pictureRefIndex !== null && !pictures.includes(binding.pictureRefIndex)) pictures.unshift(binding.pictureRefIndex);
    if (binding.audioRefIndex !== null && !audios.includes(binding.audioRefIndex)) audios.unshift(binding.audioRefIndex);
    pictures.forEach((n) => claimedPictures.add(n)); audios.forEach((n) => claimedAudios.add(n));
    lines.push({ subject: binding.roleName + (binding.offscreen ? "（画外音）" : ""), kind: "role", pictures: [...new Set(pictures)].sort((a, b) => a - b), videos: [], audios: [...new Set(audios)].sort((a, b) => a - b) });
  }
  for (const ref of manifest.pictureRefs) if (!claimedPictures.has(ref.index)) lines.push({ subject: `${ref.sources.map((source) => SOURCE_NAMES[source] ?? source).join("+")} ${ref.filename}`, kind: ref.sources.includes("first_frame") ? "frame" : "asset", pictures: [ref.index], videos: [], audios: [] });
  for (const ref of manifest.videoRefs) {
    const soundtrack = ref.audioIndex !== null ? [ref.audioIndex] : [];
    soundtrack.forEach((n) => claimedAudios.add(n));
    lines.push({ subject: `参考视频 ${ref.filename}`, kind: "asset", pictures: [], videos: [ref.index], audios: soundtrack });
  }
  for (const ref of manifest.audioRefs) if (!claimedAudios.has(ref.index)) lines.push({ subject: `${ref.sources.map((source) => SOURCE_NAMES[source] ?? source).join("+") || "参考声音"} ${ref.filename}`, kind: "asset", pictures: [], videos: [], audios: [ref.index] });
  return lines;
}

/** Works for every Run; `names` resolves asset IDs to file names when the caller has them. */
export function describeRunMedia(run: Pick<RunRecord, "capabilityId" | "referenceManifest" | "referenceInputs" | "taskMode" | "parameters">, names: ReadonlyMap<string, string> = new Map()): RunMediaMap {
  if (run.referenceManifest) return { lines: manifestMediaMap(run.referenceManifest), source: "manifest", note: null };
  const isText = run.taskMode === "t2va" || run.parameters?.mode === "text";
  if (isText) return { lines: [], source: "none", note: "文生视频：没有图片 / 视频 / 声音参考" };
  const inputs = [...(run.referenceInputs ?? [])].sort((a, b) => a.order - b.order);
  if (!inputs.length) return { lines: [], source: "none", note: "该记录没有保存输入顺序" };
  const name = (assetId: string) => names.get(assetId) ?? `素材 ${assetId.slice(0, 8)}…`;
  const counters = { image: 0, video: 0, audio: 0 };
  const lines: MediaMapLine[] = [];
  for (const input of inputs) {
    if (input.kind === "image") {
      counters.image += 1;
      const subject = input.role === "first_frame" ? `首帧 ${name(input.assetId)}` : input.role === "last_frame" ? `尾帧 ${name(input.assetId)}` : `参考图 ${name(input.assetId)}`;
      lines.push({ subject, kind: input.role === "first_frame" || input.role === "last_frame" ? "frame" : "asset", pictures: [counters.image], videos: [], audios: [] });
    } else if (input.kind === "video") {
      // A soundtrack takes its <Audio j> label before its <Video k>.
      const audio = input.withAudio ? [++counters.audio] : [];
      counters.video += 1;
      lines.push({ subject: `参考视频 ${name(input.assetId)}`, kind: "asset", pictures: [], videos: [counters.video], audios: audio });
    } else {
      counters.audio += 1;
      lines.push({ subject: `参考声音 ${name(input.assetId)}`, kind: "asset", pictures: [], videos: [], audios: [counters.audio] });
    }
  }
  return { lines, source: "input_order", note: run.capabilityId === "h3_ref2va" ? "旧版记录：按提交顺序推断，没有角色绑定" : null };
}
