export function video1080Dimensions(width: number, height: number, shortEdge: 720 | 1080 = 1080) {
  if (!(width > 0 && height > 0)) throw new Error("无法读取原视频尺寸");
  const ratio = Math.max(width, height) / Math.min(width, height);
  const long = Math.abs(ratio - 16 / 9) < 0.1 ? (shortEdge === 720 ? 1280 : 1920) : Math.round(shortEdge * ratio / 2) * 2;
  return width >= height ? { width: long, height: shortEdge } : { width: shortEdge, height: long };
}
