import { normalizeTransform } from "./whitebox.ts";
import type { Camera, Motion, MotionKeyframe, Prop, Scene, Transform } from "./schema.ts";

/**
 * Motion V0.2 — white-box spatial animation, pure helpers (no three.js; testable in Node).
 *
 * Only keyframes with a `transform` (pose) take part; text-only keyframes stay planning notes. Between
 * two posed keyframes position and scale are interpolated linearly, rotation per axis (three.js XYZ
 * Euler degrees) along the shorter way round. Before the first / after the last posed keyframe the
 * object holds that pose. No easing, no physics. Frames count at 24 FPS.
 */

export const MOTION_FPS = 24;
export type Vec3 = [number, number, number];
export type PosedKeyframe = MotionKeyframe & { transform: Transform };

export const posedKeyframes = (keyframes: MotionKeyframe[]) => keyframes.filter((keyframe): keyframe is PosedKeyframe => Boolean(keyframe.transform));
export const isSpatialMotion = (motion: Pick<Motion, "keyframes">) => motion.keyframes.some((keyframe) => keyframe.transform);

/** Signed angle a → b in (−180, 180]: the shorter way round. */
export const shortestDelta = (from: number, to: number) => { const delta = ((((to - from) % 360) + 540) % 360) - 180; return delta === -180 ? 180 : delta; };
const wrap = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number) => [0, 1, 2].map((axis) => lerp(a[axis], b[axis], t)) as Vec3;

/** The pose at `frame` (may be fractional), or null when the Motion has no posed keyframe (text mode). */
export function sampleMotion(keyframes: MotionKeyframe[], frame: number): Transform | null {
  const posed = posedKeyframes(keyframes);
  if (!posed.length) return null;
  if (frame <= posed[0].frame) return posed[0].transform;
  const last = posed[posed.length - 1];
  if (frame >= last.frame) return last.transform;
  const next = posed.findIndex((keyframe) => keyframe.frame > frame);
  const a = posed[next - 1], b = posed[next];
  const t = (frame - a.frame) / (b.frame - a.frame);
  return {
    position: lerp3(a.transform.position, b.transform.position, t),
    rotation: [0, 1, 2].map((axis) => wrap(a.transform.rotation[axis] + shortestDelta(a.transform.rotation[axis], b.transform.rotation[axis]) * t)) as Vec3,
    scale: lerp3(a.transform.scale, b.transform.scale, t),
  };
}

/** Last posed frame of the Scene's Motions (0 when nothing is posed): where playback stops. */
export const motionEndFrame = (motions: Pick<Motion, "keyframes">[]) => Math.max(0, ...motions.flatMap((motion) => posedKeyframes(motion.keyframes).map((keyframe) => keyframe.frame)));

/**
 * The Motion that drives a target during playback: `preferredId` when it is a posed Motion of that
 * target, otherwise the target's first posed Motion (several posed Motions on one target do not mix).
 */
export function drivingMotion(motions: Motion[], targetId: string, preferredId?: string | null): Motion | null {
  const own = motions.filter((motion) => motion.targetId === targetId && isSpatialMotion(motion));
  return own.find((motion) => motion.id === preferredId) ?? own[0] ?? null;
}

/**
 * Adds or updates the keyframe at `frame` (sorted result). An existing keyframe keeps its description
 * unless a non-empty one is given; `transform: null` turns it back into a text-only keyframe.
 */
export function upsertKeyframe(keyframes: MotionKeyframe[], frame: number, patch: { description?: string; transform?: Transform | null }): MotionKeyframe[] {
  const apply = (base: MotionKeyframe): MotionKeyframe => {
    const next: MotionKeyframe = { frame, description: patch.description?.trim() ? patch.description.trim() : base.description };
    const transform = patch.transform === undefined ? base.transform : patch.transform;
    return transform ? { ...next, transform: normalizeTransform(transform) } : next;
  };
  const existing = keyframes.find((keyframe) => keyframe.frame === frame);
  const rest = keyframes.filter((keyframe) => keyframe.frame !== frame);
  return [...rest, apply(existing ?? { frame, description: "" })].sort((a, b) => a.frame - b.frame);
}

/* ── Blender export preparation (no animation rendering yet) ─────────────── */

export const MOTION_EXPORT_FORMAT = "frameflow-motion-v1";
export type MotionTrack = {
  motionId: string; name: string; targetType: Motion["targetType"]; targetId: string; targetName: string;
  /** For Props: "box" / "plane" (the box pivot is its bottom centre). */
  geometry?: Prop["geometry"];
  keyframes: { frame: number; seconds: number; description: string; transform: Transform }[];
};
export type MotionExport = {
  format: typeof MOTION_EXPORT_FORMAT; fps: number; sceneId: string; sceneName: string;
  coordinates: string; interpolation: string; endFrame: number; tracks: MotionTrack[];
  /** Motions with no posed keyframe (still text-only planning): listed, not animated. */
  textOnly: { motionId: string; name: string }[];
};

/**
 * Animation-ready tracks for a later Blender step. Rotations are unwrapped (each keyframe within 180°
 * of the previous one per axis) so a plain linear F-curve over these values follows exactly the path
 * the three.js preview plays.
 */
export function buildMotionExport(scene: Scene, props: Prop[], cameras: Camera[], motions: Motion[]): MotionExport {
  const names = new Map<string, { name: string; geometry?: Prop["geometry"] }>([...props.map((prop) => [prop.id, { name: prop.name, geometry: prop.geometry }] as const), ...cameras.map((camera) => [camera.id, { name: camera.name }] as const)]);
  const own = motions.filter((motion) => motion.sceneId === scene.id);
  const tracks = own.filter(isSpatialMotion).map((motion): MotionTrack => {
    let previous: Vec3 | null = null;
    const keyframes = posedKeyframes(motion.keyframes).map((keyframe) => {
      const raw = keyframe.transform.rotation;
      const rotation: Vec3 = previous ? [0, 1, 2].map((axis) => previous![axis] + shortestDelta(previous![axis], raw[axis])) as Vec3 : [...raw] as Vec3;
      previous = rotation;
      return { frame: keyframe.frame, seconds: Math.round((keyframe.frame / MOTION_FPS) * 1000) / 1000, description: keyframe.description, transform: { ...keyframe.transform, rotation: rotation.map((value) => Math.round(value * 10) / 10) as Vec3 } };
    });
    const target = names.get(motion.targetId);
    return { motionId: motion.id, name: motion.name, targetType: motion.targetType, targetId: motion.targetId, targetName: target?.name ?? motion.targetId, ...(target?.geometry ? { geometry: target.geometry } : {}), keyframes };
  });
  return {
    format: MOTION_EXPORT_FORMAT, fps: MOTION_FPS, sceneId: scene.id, sceneName: scene.name,
    coordinates: "three.js space: metres, Y up, XYZ Euler degrees (matrix = Rx*Ry*Rz); Blender world = Rx(+90deg) * three",
    interpolation: "linear position / scale; rotation per axis, unwrapped (linear F-curves reproduce the preview); hold before first / after last keyframe",
    endFrame: motionEndFrame(own), tracks,
    textOnly: own.filter((motion) => !isSpatialMotion(motion)).map((motion) => ({ motionId: motion.id, name: motion.name })),
  };
}
