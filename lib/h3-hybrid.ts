// 当前无 app/components 入口；scripts/test-h3-modes.mjs 历史回归仍使用，删除前必须另行确认测试范围。
import type { ReferenceManifest } from "./reference-manifest.ts";
import type { H3MediaCounts } from "./h3-preflight.ts";

/**
 * 🧪 Hybrid (exact first/last frame + role references) — interface only. The current backend
 * (ComfyUI core H3 nodes) cannot lock keyframes while using references, so nothing here submits.
 *
 * How an experimental backend (T8 AudioConditioning, see docs/H3_T8_AUDIT_2026-09-25.md §4) numbers
 * media: keyframes are presented first — first frame = <Picture 1>, last frame = the next picture —
 * then the reference pictures; videos (soundtrack <Audio> before its <Video>) and standalone audios
 * keep the Reference Manifest order. The Phase 5 Manifest itself is not changed: a picture whose
 * only source is the first frame becomes the keyframe instead of a duplicate reference picture.
 */

export interface HybridFrame { assetId: string | null; filename: string }
export interface HybridPicture { index: number; role: "first_frame_keyframe" | "last_frame_keyframe" | "reference"; assetId: string | null; filename: string; roleIds: string[] }

export interface HybridPlan {
  keyframes: { position: "first" | "last"; pictureIndex: number; frame: HybridFrame }[];
  pictures: HybridPicture[];
  /** Manifest picture index → Hybrid picture index (references shift behind the keyframes). */
  pictureRenumbering: Record<number, number>;
  counts: H3MediaCounts;
  backendEnabled: false;
}

export function planHybrid(input: { firstFrame: HybridFrame | null; lastFrame: HybridFrame | null; manifest: ReferenceManifest }): HybridPlan {
  const { manifest } = input;
  const pictures: HybridPicture[] = [];
  const keyframes: HybridPlan["keyframes"] = [];
  if (input.firstFrame) { pictures.push({ index: pictures.length + 1, role: "first_frame_keyframe", assetId: input.firstFrame.assetId, filename: input.firstFrame.filename, roleIds: [] }); keyframes.push({ position: "first", pictureIndex: pictures.length, frame: input.firstFrame }); }
  if (input.lastFrame) { pictures.push({ index: pictures.length + 1, role: "last_frame_keyframe", assetId: input.lastFrame.assetId, filename: input.lastFrame.filename, roleIds: [] }); keyframes.push({ position: "last", pictureIndex: pictures.length, frame: input.lastFrame }); }
  const pictureRenumbering: Record<number, number> = {};
  for (const ref of manifest.pictureRefs) {
    const onlyFirstFrame = ref.sources.length === 1 && ref.sources[0] === "first_frame" && input.firstFrame;
    if (onlyFirstFrame) { pictureRenumbering[ref.index] = 1; continue; }
    pictures.push({ index: pictures.length + 1, role: "reference", assetId: ref.assetId, filename: ref.filename, roleIds: ref.roleIds });
    pictureRenumbering[ref.index] = pictures.length;
  }
  return {
    keyframes, pictures, pictureRenumbering, backendEnabled: false,
    counts: { pictures: pictures.length, videos: manifest.videoRefs.length, audios: manifest.audioRefs.length, standaloneAudios: manifest.audioRefs.filter((ref) => ref.kind === "standalone").length, subjects: manifest.roleBindings.length },
  };
}
