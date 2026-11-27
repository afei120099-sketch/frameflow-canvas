import { promises as fs } from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseFileControls} from './inbox-control-schema.mjs';
import {publishInboxArtifacts} from './inbox-artifacts.mjs';
import {durableJson,byteHash,parseJsonBytes} from './durable-json.mjs';
export const ROOT_CONTROL_PATH = process.env.FRAMEFLOW_INBOX_ROOT || path.join(path.resolve(process.env.FRAMEFLOW_DATA_ROOT || 'data'),'inbox');

export async function readInboxRootControl(root=ROOT_CONTROL_PATH) {
  let config={autoEnqueue:false,autoChain:false,submit:false,stopSessions:[]},error;
  try {
    const parsed=JSON.parse((await fs.readFile(path.join(root,'_control.json'),'utf8')).replace(/^\uFEFF/,''));
    if(!parsed||['autoEnqueue','autoChain','submit'].some(key=>typeof parsed[key]!=='boolean'))throw Error('三项开关必须全部为 true 或 false');
    if(parsed.stopSessions!==undefined&&(!Array.isArray(parsed.stopSessions)||parsed.stopSessions.some(id=>typeof id!=='string'||!id.trim())))throw Error('stopSessions必须是非空sessionId字符串数组');
    config={autoEnqueue:parsed.autoEnqueue,autoChain:parsed.autoChain,submit:parsed.submit,stopSessions:[...new Set(parsed.stopSessions??[])],...parseFileControls(parsed)};
  } catch(cause) {error=`总控读取失败，禁止新提交：${cause.message}`;}
  const stop=await fs.stat(path.join(root,'STOP')).then(info=>info.isFile()).catch(cause=>{if(cause.code==='ENOENT')return false;error=`STOP读取失败，禁止新提交：${cause.message}`;return true;});
  const disabled=stop||!!error;
  return {...config,stop,effective:{autoEnqueue:!disabled&&config.autoEnqueue,autoChain:!disabled&&config.autoChain,submit:!disabled&&config.submit},error:error??null,readAt:new Date().toISOString(),version:1};
}

/**
 * The canvas switches (自动入队 / 急停) write the SAME two things a person would edit by hand:
 * `autoEnqueue` in _control.json (every other field kept as is) and the STOP file. No second state.
 * A missing or broken _control.json is never created or overwritten from here.
 */
const switchWrites=new Map();
export function switchInboxRootControl(patch,root=ROOT_CONTROL_PATH){
 const previous=switchWrites.get(root)??Promise.resolve();
 const work=previous.catch(()=>{}).then(async()=>{
  const keys=Object.keys(patch??{});
  if(!keys.length||keys.some(key=>!['autoEnqueue','stop'].includes(key)||typeof patch[key]!=='boolean'))throw Object.assign(Error('只能切换 autoEnqueue 或 stop（true / false）'),{status:400});
  if(typeof patch.autoEnqueue==='boolean'){
   const file=path.join(root,'_control.json');
   const bytes=await fs.readFile(file).catch(cause=>{if(cause.code==='ENOENT')throw Object.assign(Error('收件箱里还没有 _control.json，界面不替你新建；请先按说明建好（autoEnqueue / autoChain / submit 三项）'),{status:409});throw cause;});
   let parsed;try{parsed=parseJsonBytes(bytes);}catch(cause){throw Object.assign(Error('_control.json 读不出来（'+cause.message+'），没有改动它'),{status:409});}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||['autoEnqueue','autoChain','submit'].some(key=>typeof parsed[key]!=='boolean'))throw Object.assign(Error('_control.json 三项开关不全是 true / false，没有改动它'),{status:409});
   if(parsed.autoEnqueue!==patch.autoEnqueue)await durableJson(file,{...parsed,autoEnqueue:patch.autoEnqueue},{expectedCurrentSha256:byteHash(bytes)});
  }
  if(patch.stop===true){const file=path.join(root,'STOP');const exists=await fs.stat(file).then(info=>info.isFile()).catch(cause=>{if(cause.code==='ENOENT')return false;throw cause;});if(!exists)await fs.writeFile(file,'画布界面急停 '+new Date().toISOString()+String.fromCharCode(13,10)+'删除这个文件（或在画布里点「解除急停」）即恢复。'+String.fromCharCode(13,10),{flag:'wx'}).catch(cause=>{if(cause.code!=='EEXIST')throw cause;});}
  if(patch.stop===false)await fs.unlink(path.join(root,'STOP')).catch(cause=>{if(cause.code!=='ENOENT')throw cause;});
  return readInboxRootControl(root);
 });
 switchWrites.set(root,work);return work;
}

const statusWrites=new Map();
function serializeStatus(root,work){const previous=statusWrites.get(root)??Promise.resolve();const next=previous.catch(()=>{}).then(work);statusWrites.set(root,next);return next;}
export function inboxCanvasHeartbeat(snapshot,now=Date.now()){
  const at=Date.parse(snapshot.canvasObservedAt??''),ageMs=Number.isFinite(at)?Math.max(0,now-at):null,timeoutMs=120000;
  return {observedAt:snapshot.canvasObservedAt??null,ageMs,timeoutMs,stale:ageMs===null||ageMs>timeoutMs,state:ageMs===null?'unknown':ageMs>timeoutMs?'stale':'fresh'};
}
async function writeStatus(snapshot,root) {
  const control=await readInboxRootControl(root);
  const canvasHeartbeat=inboxCanvasHeartbeat(snapshot);
  const value={...snapshot,...control,canvasHeartbeat,canvasHeartbeatStale:canvasHeartbeat.stale,updatedAt:new Date().toISOString(),note:'canvasHeartbeat只表明画布观测是否过期，不代表渲染失败；STOP/无效配置禁止新提交，旧停止批次不恢复'};
  await durableJson(path.join(root,'_control_status.json'),value);
  return value;
}
export function writeInboxRootStatus(snapshot,root=ROOT_CONTROL_PATH){return serializeStatus(root,()=>writeStatus(snapshot,root));}
export function refreshInboxHeartbeatStatus(root=ROOT_CONTROL_PATH){return serializeStatus(root,async()=>{
 const snapshot=await fs.readFile(path.join(root,'_control_status.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 return snapshot?writeStatus(snapshot,root):null;
});}

/** Node-side gate precedes the ComfyUI proxy; no request body ever reaches ComfyUI when held. */
export function inboxRootControlPlugin({root=ROOT_CONTROL_PATH}={}) {
  return {name:'frameflow-inbox-root-control',configureServer(server){
    // This watchdog lives in Node: it still marks stale observations when the
    // renderer is frozen/closed. It never invents a new canvasObservedAt.
    const timer=setInterval(()=>{void refreshInboxHeartbeatStatus(root).catch(()=>{});},4000);timer.unref?.();server.httpServer?.once('close',()=>clearInterval(timer));
    server.middlewares.use(async(req,res,next)=>{
      const pathname=new URL(req.url??'/', 'http://localhost').pathname;
      const controlPath=pathname==='/__inbox/control',statusPath=pathname==='/__inbox/control-status',artifactPath=pathname==='/__inbox/artifacts';
      const promptPath=pathname==='/comfyui/prompt'&&req.method==='POST';
      if(!controlPath&&!statusPath&&!promptPath&&!artifactPath)return next();
      const json=(code,value,headers={})=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value));};
      try {
        const host=req.headers.host??'';
        if(!/^(localhost|127\.0\.0\.1):\d+$/.test(host)||req.method==='POST'&&req.headers.origin!==`http://${host}`)return json(403,{error:'仅限本机同源画布'});
        if(promptPath){const control=await readInboxRootControl(root),kind=req.headers['x-frameflow-control-kind'],sessionId=req.headers['x-frameflow-session-id'];if(control.stopSessions.includes(sessionId))return json(423,{error:'用户通过stopSessions停止本批；请求未发送到ComfyUI',control},{'x-frameflow-submission-held':'1','x-frameflow-session-stopped':'1'});if(!control.effective.submit||control.pauseSessions?.includes(sessionId)||kind==='chain'&&!control.effective.autoChain||kind==='automatic'&&!control.effective.autoEnqueue)return json(423,{error:'根总控暂停提交；请求未发送到ComfyUI',control},{'x-frameflow-submission-held':'1'});return next();}
        if(artifactPath&&req.method==='POST'){
          const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>12*1024*1024)return json(413,{error:'报告/小图过大'});chunks.push(chunk);}
          return json(200,await publishInboxArtifacts(root,JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        }
        if(controlPath&&req.method==='GET')return json(200,await readInboxRootControl(root));
        if(controlPath&&req.method==='POST'){
          const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)return json(413,{error:'请求过大'});chunks.push(chunk);}
          let patch;try{patch=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(400,{error:'请求不是 JSON'});}
          try{return json(200,await switchInboxRootControl(patch,root));}catch(cause){return json(cause.status??503,{error:cause.message,control:await readInboxRootControl(root)});}
        }
        if(statusPath&&req.method==='GET')return json(200,await refreshInboxHeartbeatStatus(root));
        if(statusPath&&req.method==='POST'){
          const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)return json(413,{error:'状态过大'});chunks.push(chunk);}
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          return json(200,await writeInboxRootStatus(body,root));
        }
        return json(405,{error:'不支持该方法'});
      }catch(cause){json(503,{error:cause.message},promptPath?{'x-frameflow-submission-held':'1'}:{});}
    });
  }};
}
