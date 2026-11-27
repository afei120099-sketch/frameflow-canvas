import type { ReferenceManifest } from "./reference-manifest.ts";
export type CapturedVideoFrame = { src: string; name: string; sourceNodeId: string };
/** Patch only keyframe input/mode fields; prompt, references, roles, seed and sampling stay untouched. */
export function videoFrameHandoffPatch(role: "first" | "last", frame: CapturedVideoFrame) {
  return {
    ...(role === "first" ? { videoFirstFrame: frame } : { videoLastFrame: frame }),
    ultimateKeyframes: true, allReferenceMode: false,
    // An explicit user edit opts this node out of the queue's automatic Ref2VA-only migration.
    workflowLock: "", hybridLock: false,
  };
}
export const videoHandoffEdges = (side: "left" | "right") =>
  side === "left" ? { capture: "first" as const, target: "last" as const } : { capture: "last" as const, target: "first" as const };

/** T8 tokenizes exact keyframes first. Adapt only the submission, never the editor prompt. */
export function prepareKeyframeSubmission(manifest: ReferenceManifest, prompt: string, frames?: {first?: number; last?: number}) {
  if (!frames) return {manifest, prompt, frames};
  const edges = [frames.first, frames.last].filter((n): n is number => n !== undefined);
  const order = [...edges, ...manifest.pictureRefs.map(r => r.index).filter(n => !edges.includes(n))];
  if (new Set(order).size !== manifest.pictureRefs.length || order.some(n => !manifest.pictureRefs[n-1])) throw new Error("首尾帧参考编号无效");
  const mapping = new Map(order.map((old, i) => [old, i+1]));
  const next = structuredClone(manifest);
  next.pictureRefs = order.map((old, i) => ({...next.pictureRefs[old-1], index:i+1, label:`<Picture ${i+1}>`}));
  next.roleBindings = next.roleBindings.map(r => ({...r, pictureRefIndex:r.pictureRefIndex === null ? null : mapping.get(r.pictureRefIndex)!}));
  next.submissionOrder.images = next.pictureRefs.map(r => r.assetId);
  // One pass prevents cascading substitutions; tags and plain Picture references use the same map.
  const adapted = prompt.replace(/\bPicture\s+(\d+)\b/gi, (text, n) => mapping.has(Number(n)) ? `Picture ${mapping.get(Number(n))}` : text);
  return {manifest:next, prompt:adapted, frames:{
    ...(frames.first ? {first:mapping.get(frames.first)} : {}),
    ...(frames.last ? {last:mapping.get(frames.last)} : {}),
  }};
}
