/** Match the existing tail-frame extraction, but encode the chosen pixels as PNG. */
export function tailFrameSeconds(duration:number){
  if(!Number.isFinite(duration)||duration<=0)throw Error('视频时长无效，无法提取尾帧');
  return Math.max(0,duration-Math.min(.08,duration/10));
}
