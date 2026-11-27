export const H3_FPS = 24;
export const H3_LENGTH_GRID = 17;
export const H3_LENGTH_OFFSET = 5;
export const H3_MIN_LENGTH = 124;
export const H3_TRAINED_MAX_LENGTH_BOUND = 362;
export const H3_MAX_LENGTH = H3_LENGTH_OFFSET + Math.floor((H3_TRAINED_MAX_LENGTH_BOUND - H3_LENGTH_OFFSET) / H3_LENGTH_GRID) * H3_LENGTH_GRID;
export const H3_MAX_REQUESTED_SECONDS = Math.floor(H3_MAX_LENGTH / H3_FPS * 10) / 10;
export const H3_DEFAULT_LENGTH = 141;
export const H3_MEGAPIXELS = 0.5;
export const H3_MIN_MEGAPIXELS = 0.3;
export const H3_MAX_MEGAPIXELS = 1;
export const H3_TURBO = true;
export const H3_STEPS = 6;
export const H3_NON_TURBO_STEPS = 20;
export const H3_LORA_STRENGTH = 1;
export const H3_UPSCALE_METHOD = "lanczos";
export const H3_RESOLUTION_STEPS = 32;
export const H3_UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"] as const;

export const H3_ASPECTS = ["follow", "16:9", "9:16", "1:1", "4:3", "3:4"] as const;
export type H3Aspect = (typeof H3_ASPECTS)[number];

export const H3_ASPECT_LABELS: Record<H3Aspect, string> = {
  follow: "跟随原图",
  "16:9": "16:9",
  "9:16": "9:16",
  "1:1": "1:1",
  "4:3": "4:3",
  "3:4": "3:4",
};

export const H3_ASPECT_DIMENSIONS: Record<Exclude<H3Aspect, "follow">, [number, number]> & { follow: null } = {
  follow: null,
  "16:9": [1024, 576],
  "9:16": [576, 1024],
  "1:1": [768, 768],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
};

export function isH3Aspect(value: string): value is H3Aspect {
  return (H3_ASPECTS as readonly string[]).includes(value);
}

export function lengthToSeconds(length: number) {
  return length / H3_FPS;
}

export function formatRequestedSeconds(seconds: number) {
  return seconds.toFixed(1);
}

export function secondsToH3Length(seconds: number) {
  const boundedFrames = Math.min(H3_MAX_LENGTH, Math.max(H3_MIN_LENGTH, seconds * H3_FPS));
  const gridIndex = Math.round((boundedFrames - H3_LENGTH_OFFSET) / H3_LENGTH_GRID);
  return Math.min(H3_MAX_LENGTH, Math.max(H3_MIN_LENGTH, gridIndex * H3_LENGTH_GRID + H3_LENGTH_OFFSET));
}

export function normalizeRequestedSeconds(value: string | number) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value.replace("秒", ""));
  if (!Number.isFinite(parsed)) return lengthToSeconds(H3_DEFAULT_LENGTH);
  return Math.min(H3_MAX_REQUESTED_SECONDS, Math.max(lengthToSeconds(H3_MIN_LENGTH), parsed));
}

export function getActualDuration(value: string | number) {
  const requestedSeconds = normalizeRequestedSeconds(value);
  const length = secondsToH3Length(requestedSeconds);
  return { requestedSeconds, length, actualSeconds: lengthToSeconds(length) };
}

export function calculateH3Dimensions(sourceWidth: number, sourceHeight: number, aspect: H3Aspect, megapixels: number, resolutionSteps: number) {
  const selected = H3_ASPECT_DIMENSIONS[aspect];
  const ratioWidth = selected?.[0] ?? sourceWidth;
  const ratioHeight = selected?.[1] ?? sourceHeight;
  if (!ratioWidth || !ratioHeight) return null;
  const scale = Math.sqrt(megapixels * 1024 * 1024 / (ratioWidth * ratioHeight));
  return {
    width: Math.round(ratioWidth * scale / resolutionSteps) * resolutionSteps,
    height: Math.round(ratioHeight * scale / resolutionSteps) * resolutionSteps,
  };
}
