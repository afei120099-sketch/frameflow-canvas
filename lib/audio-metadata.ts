export async function readAudioDuration(blob:Blob):Promise<number>{
 if(!blob.size)throw new Error('声音文件为空');
 return new Promise((resolve,reject)=>{
  const audio=new Audio(),url=URL.createObjectURL(blob);let finished=false;
  const finish=(duration?:number)=>{if(finished)return;finished=true;clearTimeout(timer);audio.onloadedmetadata=null;audio.onerror=null;audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url);if(duration&&Number.isFinite(duration))resolve(duration);else reject(new Error('无法读取声音时长，请检查音频格式'));};
  const timer=setTimeout(()=>finish(),15000);audio.preload='metadata';audio.onloadedmetadata=()=>finish(audio.duration);audio.onerror=()=>finish();audio.src=url;
 });
}
