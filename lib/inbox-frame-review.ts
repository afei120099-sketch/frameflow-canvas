import {getLocalVideoBlob} from './local-video-store.ts';
/** CPU browser decode only. Never submits ComfyUI, uploads MP4, or rewrites source media. */
export async function inboxReviewFrames(storageReference:string){
 const blob=await getLocalVideoBlob(storageReference);if(!blob.size)throw Error('视频为空');
 const url=URL.createObjectURL(blob),video=document.createElement('video');video.muted=true;video.preload='auto';video.src=url;
 const event=(name:string)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('抽帧超时：'+name));},30000);const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(Error('视频解码失败'));};const cleanup=()=>{clearTimeout(timer);video.removeEventListener(name,done);video.removeEventListener('error',fail);};video.addEventListener(name,done,{once:true});video.addEventListener('error',fail,{once:true});});
 try{
  await event('loadeddata');if(!Number.isFinite(video.duration)||video.duration<=0||!video.videoWidth)throw Error('视频元数据不可读');
  const width=Math.min(640,video.videoWidth),height=Math.max(1,Math.round(video.videoHeight*width/video.videoWidth));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d')!;
  const images:Record<string,string>={},snapshots:Record<string,HTMLCanvasElement>={};
  for(const [key,fraction]of [['first',0],['25',.25],['50',.5],['75',.75],['last',1]] as const){const time=Math.max(0,Math.min(video.duration-.001,video.duration*fraction));if(Math.abs(video.currentTime-time)>.001){const ready=event('seeked');video.currentTime=time;await ready;}ctx.drawImage(video,0,0,width,height);images[key]=canvas.toDataURL('image/jpeg',.82);const copy=document.createElement('canvas');copy.width=width;copy.height=height;copy.getContext('2d')!.drawImage(canvas,0,0);snapshots[key]=copy;}
  const sheet=document.createElement('canvas');sheet.width=width*2;sheet.height=height*2;const sc=sheet.getContext('2d')!;['first','25','50','last'].forEach((key,index)=>sc.drawImage(snapshots[key],index%2*width,Math.floor(index/2)*height));images.sheet=sheet.toDataURL('image/jpeg',.8);return images;
 }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
