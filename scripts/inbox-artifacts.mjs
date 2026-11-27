import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {durableJson} from './durable-json.mjs';
const safe=name=>typeof name==='string'&&name.length>0&&name.length<180&&!/[\\/:*?"<>|\x00-\x1f]/.test(name)&&name!=='.'&&name!=='..';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const queues=new Map();
async function noLink(file){const stat=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(stat?.isSymbolicLink())throw Error('不跟随报告文件链接');}
async function atomic(file,value){await noLink(file);await durableJson(file,value);}
async function guardedDir(parent,name){if(!safe(name))throw Error('非法报告目录名');const dir=path.join(parent,name);await noLink(dir);await fs.mkdir(dir,{recursive:true});const real=await fs.realpath(dir),root=await fs.realpath(parent);if(!real.startsWith(root+path.sep))throw Error('目录不在收件箱内');return dir;}
export async function publishInboxArtifacts(root,input){
 if(!safe(input.project))throw Error('非法项目名');
 const project=await guardedDir(root,input.project);
 const previous=queues.get(project)??Promise.resolve();
 const work=previous.catch(()=>{}).then(async()=>{
  if(input.validation){
   if(!safe(input.source)||!/_validate\.json$|_queue\.json$/i.test(input.source))throw Error('校验源文件名无效');
   const file=`_compiled_${input.source}`;await atomic(path.join(project,file),{source:input.source,updatedAt:new Date().toISOString(),...input.validation});return{ok:true,file};
  }
  let batch=input.batch;if(!batch||typeof batch.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(batch.sessionId)||!Array.isArray(batch.shots))throw Error('批次报告格式无效');
  const file=path.join(project,`_batch_${batch.sessionId}.json`);await noLink(file);const old=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(old?.observedAt>batch.observedAt){if(!input.frames)return{ok:true,state:'stale_ignored'};batch={...old};}
  const signature=digest([batch.state,batch.paused,batch.stopped,batch.stopReason,batch.shots.map(s=>[s.nodeId,s.runId,s.state,s.reason,s.frameInputs])]);
  const revision=(old?.revision??0)+(old?.signature===signature?0:1),now=new Date().toISOString();
  if(old?.signature!==signature){
   const log=path.join(project,'_events.jsonl');await noLink(log);const existing=await fs.readFile(log,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
   const events=[{type:'batch',sessionId:batch.sessionId,state:batch.state,paused:batch.paused,stopped:batch.stopped,reason:batch.stopReason}];
   for(const shot of batch.shots){const prior=old?.shots?.find(s=>s.index===shot.index);if(!prior||digest([prior.runId,prior.state,prior.reason,prior.frameInputs])!==digest([shot.runId,shot.state,shot.reason,shot.frameInputs]))events.push({type:'shot',sessionId:batch.sessionId,index:shot.index,title:shot.title,nodeId:shot.nodeId,runId:shot.runId,state:shot.state,error:shot.reason,frameInputs:shot.frameInputs});}
   const lines=events.map(event=>({eventId:digest([batch.sessionId,revision,event]),at:now,revision,...event})).filter(event=>!existing.includes(`"eventId":"${event.eventId}"`));
   if(lines.length)await fs.appendFile(log,lines.map(line=>JSON.stringify(line)+'\n').join(''),'utf8');
  }
  const frames={...(old?.frames??{})};
  if(input.frames){
   const {title,runId,images}=input.frames;if(!safe(title)||!safe(runId)||!images||!['first','last','25','50','75','sheet'].every(key=>typeof images[key]==='string'&&/^data:image\/jpeg;base64,/.test(images[key])))throw Error('抽帧格式无效');
   if(!batch.shots.some(s=>s.runId===runId&&s.state==='completed'||s.attempts?.some(a=>a.runId===runId&&a.state==='completed')))throw Error('抽帧不属于本批已完成任务');
   const titleDir=await guardedDir(await guardedDir(project,'_frames'),title),runDir=await guardedDir(titleDir,runId);
   for(const [key,data]of Object.entries(images)){
    if(!['first','last','25','50','75','sheet'].includes(key))throw Error('未知抽帧文件');const bytes=Buffer.from(data.split(',')[1],'base64');if(bytes.length>2*1024*1024||bytes[0]!==255||bytes[1]!==216)throw Error('不是有效的小型JPG');
    // Immutable per-Run originals; latest sheet is a replaceable preview, never user media.
    await fs.writeFile(path.join(runDir,key+'.jpg'),bytes,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    if(key==='sheet'){await noLink(path.join(titleDir,'sheet.jpg'));await fs.writeFile(path.join(titleDir,'sheet.jpg'),bytes);}
   }
   frames[runId]={directory:runDir,sheet:path.join(titleDir,'sheet.jpg'),images:['first','last','25','50','75'].map(k=>path.join(runDir,k+'.jpg'))};
  }
  await atomic(file,{...batch,frames,revision,signature,updatedAt:now});return{ok:true,file,frames};
 });queues.set(project,work);return work;
}
