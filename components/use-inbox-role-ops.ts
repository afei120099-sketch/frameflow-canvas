"use client";
// Inbox role ops: external programs drop `_roles.json` into the inbox root
// (<FRAMEFLOW_INBOX_ROOT>\_roles.json) or any project subfolder.
// Ops run in the open canvas (IndexedDB role store), without clicking 角色 UI.
// Idempotent by `id` (each id executes once). Missing roleId/assetId errors out.
// Results: `_roles_status.json`. Never deletes roles, assets, nodes, or files.
import {useEffect} from 'react';
import {getAsset} from '@/lib/production-records';
import {addRoleAsset,createRole,getRole,setPrimaryRoleAsset,updateRoleDetails} from '@/lib/role-records';

export type InboxRoleOp = {id:string;op:string;name?:string;description?:string;roleId?:string;assetId?:string;setMain?:boolean};
export type InboxRoleOpResult = {id:string;op:string;ok:boolean;skipped?:boolean;pending?:boolean;roleId?:string;assetId?:string;added?:boolean;primaryAppearanceAssetId?:string|null;error?:string;at:string};
export type InboxRoleStatus = {updatedAt:string;ok:boolean;results:InboxRoleOpResult[];done:Record<string,InboxRoleOpResult>;parseError?:string};

const ROLES_FILE='_roles.json', STATUS_FILE='_roles_status.json', ROOT_PROJECT='__root__';
const url=(p:Record<string,string>)=>`/api/inbox?${new URLSearchParams(p)}`;
async function json<T>(params:Record<string,string>, body?:unknown):Promise<{ok:boolean;status:number;value:T|null;error?:string}>{
  const response=await fetch(url(params),{cache:'no-store',...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})});
  const text=await response.text();
  let value:T|null=null;
  try{value=text?JSON.parse(text) as T:null;}catch{/* non-JSON error body */}
  return {ok:response.ok,status:response.status,value,error:response.ok?undefined:(value && typeof value==='object' && 'error' in value ? String((value as {error:unknown}).error) : text || `HTTP ${response.status}`)};
}

function parseOps(text:string):InboxRoleOp[]{
  const parsed=JSON.parse(text.replace(/^\uFEFF/,'')) as unknown;
  const ops=Array.isArray(parsed)?parsed:(parsed && typeof parsed==='object' && Array.isArray((parsed as {ops?:unknown}).ops)?(parsed as {ops:unknown[]}).ops:null);
  if(!Array.isArray(ops))throw Error('_roles.json 必须是操作数组，例如 [{"id":"op1","op":"create","name":"..."}]，或 {ops:[...]}');
  return ops as InboxRoleOp[];
}

async function requireRole(roleId:string){
  const id=roleId.trim();
  if(!id)throw Error('缺少 roleId');
  const role=await getRole(id);
  if(!role)throw Error(`角色不存在或不属于当前画布: ${id}`);
  return role;
}
async function requireImageAsset(assetId:string){
  const id=assetId.trim();
  if(!id)throw Error('缺少 assetId');
  const asset=await getAsset(id);
  if(!asset)throw Error(`素材不存在或不属于当前画布: ${id}`);
  if(asset.kind!=='image')throw Error(`素材不是图片: ${id} (${asset.kind})`);
  return asset;
}

export async function executeInboxRoleOp(raw:InboxRoleOp):Promise<InboxRoleOpResult>{
  const at=new Date().toISOString(), id=String(raw.id??'').trim(), op=String(raw.op??'');
  const fail=(error:string):InboxRoleOpResult=>({id,op,ok:false,error,at});
  try{
    if(!id)return fail('缺少 id，未执行');
    if(op==='create'){
      const name=String(raw.name??'').trim();
      if(!name)return fail('create 缺少 name');
      const requested=String(raw.roleId??'').trim();
      if(requested){
        const existing=await getRole(requested);
        if(existing)return {id,op,ok:true,skipped:true,roleId:existing.roleId,at};
      }
      const role=await createRole(name, requested || undefined);
      if(raw.description!==undefined)await updateRoleDetails(role.roleId,{description:String(raw.description)});
      return {id,op,ok:true,roleId:role.roleId,at};
    }
    if(op==='addAppearance'){
      const role=await requireRole(String(raw.roleId??''));
      const asset=await requireImageAsset(String(raw.assetId??''));
      const added=(await addRoleAsset(role.roleId,asset.assetId,'image')).added;
      const next=raw.setMain===true?await setPrimaryRoleAsset(role.roleId,asset.assetId,'image'):await getRole(role.roleId);
      return {id,op,ok:true,roleId:role.roleId,assetId:asset.assetId,added,primaryAppearanceAssetId:next?.primaryAppearanceAssetId??null,at};
    }
    if(op==='setMainAppearance'){
      const role=await requireRole(String(raw.roleId??''));
      const asset=await requireImageAsset(String(raw.assetId??''));
      if(!role.appearanceAssetIds.includes(asset.assetId))throw Error(`素材未加入该角色外观列表，请先 addAppearance: ${asset.assetId}`);
      const next=await setPrimaryRoleAsset(role.roleId,asset.assetId,'image');
      return {id,op,ok:true,roleId:role.roleId,assetId:asset.assetId,primaryAppearanceAssetId:next.primaryAppearanceAssetId,at};
    }
    return fail(`未知 op: ${op}`);
  }catch(error){return fail(error instanceof Error?error.message:String(error));}
}

export async function applyInboxRoleOps(ops:InboxRoleOp[], previous:InboxRoleStatus|null, checkpoint?:(status:InboxRoleStatus)=>Promise<void>):Promise<InboxRoleStatus>{
  const done={...(previous?.done??{})};
  const results:InboxRoleOpResult[]=[];
  const seen=new Set<string>();
  for(const raw of ops){
    const id=typeof raw?.id==='string'?raw.id.trim():'';
    const op=String(raw?.op??'');
    if(!id){results.push({id:'',op,ok:false,error:'缺少 id，未执行',at:new Date().toISOString()});continue;}
    if(seen.has(id)){results.push({id,op,ok:false,skipped:true,error:'同一文件中重复 id，未再次执行',at:new Date().toISOString()});continue;}
    seen.add(id);
    const prior=done[id];
    if(prior && (prior.ok || !prior.pending)){results.push(prior);continue;}
    if(op==='create'){
      const name=String(raw.name??'').trim();
      if(!name){
        const missing:InboxRoleOpResult={id,op,ok:false,error:'create 缺少 name',at:new Date().toISOString()};
        results.push(missing);done[id]=missing;continue;
      }
      const reserved=prior?.roleId || String(raw.roleId??'').trim() || crypto.randomUUID();
      const existing=await getRole(reserved);
      if(existing){
        const reused:InboxRoleOpResult={id,op,ok:true,skipped:true,roleId:existing.roleId,at:new Date().toISOString()};
        results.push(reused);done[id]=reused;continue;
      }
      const pending:InboxRoleOpResult={id,op,ok:false,pending:true,roleId:reserved,error:'创建尚未完成',at:new Date().toISOString()};
      done[id]=pending;
      if(checkpoint)await checkpoint({updatedAt:new Date().toISOString(),ok:false,results:[...results,pending],done:{...done}});
      const result=await executeInboxRoleOp({...raw,roleId:reserved});
      results.push(result);
      if(!result.ok && /画布尚未加载完成/.test(result.error??''))continue;
      done[id]=result;
      continue;
    }
    const result=await executeInboxRoleOp(raw);
    results.push(result);
    if(!result.ok && /画布尚未加载完成/.test(result.error??''))continue;
    done[id]=result;
  }
  return {updatedAt:new Date().toISOString(),ok:results.every(item=>item.ok),results,done};
}

function stampless(status:InboxRoleStatus){
  const rest=({at:_at,...item}:InboxRoleOpResult)=>item;
  return JSON.stringify({ok:status.ok,parseError:status.parseError,results:status.results.map(rest),done:Object.fromEntries(Object.entries(status.done).map(([key,value])=>[key,rest(value)]))});
}
function sameStatus(a:InboxRoleStatus|null, b:InboxRoleStatus){
  return !!a && stampless(a)===stampless(b);
}

async function readRolesText(project:string){
  if(project===ROOT_PROJECT){
    const result=await json<unknown>({op:'root-file',name:ROLES_FILE});
    if(result.status===404 || result.status===400)return null;
    if(!result.ok)throw Error(result.error??'根目录 _roles.json 读取失败');
    return typeof result.value==='string'?result.value:JSON.stringify(result.value);
  }
  const listed=await json<{files:{name:string}[]}>({op:'list',project});
  if(!listed.ok || !listed.value?.files.some(file=>file.name===ROLES_FILE))return null;
  const file=await json<unknown>({op:'file',project,name:ROLES_FILE});
  if(!file.ok)throw Error(file.error??`${project}/_roles.json 读取失败`);
  return typeof file.value==='string'?file.value:JSON.stringify(file.value);
}
function asStatus(value:InboxRoleStatus|null, ok:boolean, error?:string):InboxRoleStatus|null{
  if(!ok)throw Error(error??'_roles_status.json 读取失败，本轮不执行以免重复');
  if(!value)return null;
  if(typeof value!=='object' || value.done===undefined || !Array.isArray(value.results))throw Error('_roles_status.json 损坏，本轮不执行以免重复');
  return value;
}
async function readStatus(project:string):Promise<InboxRoleStatus|null>{
  if(project===ROOT_PROJECT){
    const result=await json<InboxRoleStatus>({op:'root-file',name:STATUS_FILE});
    if(result.status===404 || result.status===400)return null;
    return asStatus(result.value, result.ok, result.error);
  }
  const listed=await json<{files:{name:string}[]}>({op:'list',project});
  if(!listed.ok || !listed.value?.files.some(file=>file.name===STATUS_FILE))return null;
  const file=await json<InboxRoleStatus>({op:'file',project,name:STATUS_FILE});
  return asStatus(file.value, file.ok, file.error);
}
async function writeStatus(project:string, status:InboxRoleStatus){
  const result=project===ROOT_PROJECT
    ? await json({op:'root-write',name:STATUS_FILE}, status)
    : await json({op:'write',project,name:STATUS_FILE}, status);
  if(!result.ok)throw Error(result.error??`${project} 状态写入失败 HTTP ${result.status}`);
}

async function processProject(project:string){
  const text=await readRolesText(project);
  if(text===null)return;
  const previous=await readStatus(project);
  let next:InboxRoleStatus;
  try{
    next=await applyInboxRoleOps(parseOps(text), previous, async draft=>{
      const latest=await readStatus(project);
      if(sameStatus(latest,draft))return;
      await writeStatus(project,draft);
    });
  }
  catch(error){
    let latest:InboxRoleStatus|null=previous;
    try{latest=await readStatus(project);}catch{latest=previous;}
    if(latest && !sameStatus(previous,latest))return;
    next={updatedAt:new Date().toISOString(),ok:false,results:previous?.results??[],done:previous?.done??{},parseError:error instanceof Error?error.message:String(error)};
  }
  if(sameStatus(previous,next))return;
  await writeStatus(project,next);
  console.info('[inbox role ops]',project,next);
}

/** Poll inbox root and every project folder for `_roles.json`. */
export function useInboxRoleOps(){
  useEffect(()=>{
    let stopped=false,busy=false;
    const poll=async()=>{
      if(stopped||busy)return;busy=true;
      try{
        if(!navigator.locks){console.warn('[inbox role ops] 浏览器不支持跨标签锁，跳过本轮');return;}
        await navigator.locks.request('frameflow-inbox-role-ops-v1',{ifAvailable:true},async lock=>{
          if(!lock||stopped)return;
          await processProject(ROOT_PROJECT).catch(error=>console.warn('[inbox role ops] __root__',error));
          const projects=await json<{projects:string[]}>({op:'projects'});
          if(!projects.ok)return;
          for(const project of projects.value?.projects??[]){
            if(stopped)return;
            await processProject(project).catch(error=>console.warn('[inbox role ops]',project,error));
          }
        });
      }catch(error){console.warn('[inbox role ops]',error);}
      finally{busy=false;}
    };
    void poll();const timer=setInterval(()=>void poll(),5000);
    return()=>{stopped=true;clearInterval(timer);};
  },[]);
}
