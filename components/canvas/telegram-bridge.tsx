"use client";
import { useEffect } from "react";
import { listShots, listRuns } from "@/lib/production-records";
import { listRoles } from "@/lib/role-records";
type Draft = {first:string|null;last:string|null;references:string[];roleIds:string[]};
type Command = { id: string; kind: string; nodeId?: string; after?: number; draft?:Draft;prompt?:string;workflow?:string;parameters?:{length:number;aspect:string;megapixels:number} };
type CanvasAPI = { list(): { id: string; type: string; shotId?: string; generationCount?: number }[]; generate(id: string): Promise<{started?:boolean}>; addImage(source:{dataUrl:string;name:string}):Promise<{id:string}>;createH3(options:Record<string,unknown>):Promise<{id:string}> };
const base = "http://127.0.0.1:5178";
export function TelegramCanvasBridge() {
  useEffect(() => {
    let disposed = false, key = "", inFlight = false;
    const processed = new Map<string, unknown>();
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}/bridge/${path}`, { method: body ? "POST" : "GET", headers: { "X-Frameflow-Bridge": key, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
      if(!response.ok) { if(response.status===403)key=""; throw Error("手机桥接暂未连接"); }
      return response.json();
    };
    const tick = async () => {
      if(disposed || inFlight)return;inFlight=true;
      try {
        if(!key){ const response=await fetch(`${base}/bridge/session`, {cache:"no-store",signal:AbortSignal.timeout(3000)}); if(!response.ok)return;key=(await response.json() as {key:string}).key; }
        const api=(window as unknown as {frameflow?:CanvasAPI}).frameflow;
        if(!api)return;
        const [shots,roles]=await Promise.all([listShots(),listRoles()]);
        const mobileJobs=Object.keys(sessionStorage).filter(name=>name.startsWith('frameflow-mobile-')).map(name=>({commandId:name.slice('frameflow-mobile-'.length),nodeId:sessionStorage.getItem(name)})).filter(item=>item.nodeId?.startsWith('shape:'));
        await request("report",{snapshot:{mobileJobs,shots:shots.map(s=>({shotId:s.shotId,shotNumber:s.shotNumber,title:s.title,status:s.status,adoptedAssetId:s.adoptedAssetId,sourceH3NodeId:s.sourceH3NodeId})),roles:roles.map(r=>({roleId:r.roleId,displayName:r.displayName})),nodes:api.list().map(n=>({id:n.id,type:n.type,shotId:n.shotId,generationCount:n.generationCount}))}});
        const {commands}=await request("poll") as {commands:Command[]};
        for(const command of commands){
          if(disposed)break;
          let result=processed.get(command.id),error;
          try{
            if(!processed.has(command.id)){
              if(command.kind==="generate" && command.nodeId){
                if(!api.list().some(n=>n.id===command.nodeId&&n.type==="h3-node"))throw Error("镜头节点不存在");
                result=await api.generate(command.nodeId);
              }else if(command.kind==="mobileVideo"){
                const d=command.draft,p=command.parameters;
                if(!d||!p||!Array.isArray(d.references)||!Array.isArray(d.roleIds)||!command.prompt?.trim()||command.prompt.length>3000)throw Error("手机任务草稿无效");
                if(![124,243,362].includes(p.length)||!["9:16","16:9","1:1"].includes(p.aspect)||![0.5,1].includes(p.megapixels)||!["ultimate","dialogue"].includes(command.workflow??""))throw Error("手机参数无效");
                if(d.last&&!d.first)throw Error("尾帧必须同时提供首帧");
                const ids=[d.first,d.last,...d.references].filter((id):id is string=>!!id);
                if(ids.length>9||ids.some(id=>!/^[0-9a-f-]{36}$/.test(id)))throw Error("素材数量或编号无效");
                if(d.roleIds.some(id=>!roles.some(r=>r.roleId===id)))throw Error("角色已不存在，请重新选择");
                const marker=`frameflow-mobile-${command.id}`;
                if(sessionStorage.getItem(marker))throw Error("此任务已处理或状态待确认，未重复生成");
                // Mark before mutation, also surviving React remount/page refresh. Never retry an uncertain generation.
                sessionStorage.setItem(marker,"started");
                const imported=new Map<string,string>();
                for(const id of new Set(ids)){
                  const response=await fetch(`${base}/bridge/media/${id}`,{headers:{"X-Frameflow-Bridge":key},signal:AbortSignal.timeout(30000)});
                  if(!response.ok)throw Error("手机图片读取失败");
                  const blob=await response.blob();
                  const dataUrl=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error("图片读取失败"));reader.readAsDataURL(blob);});
                  const node=await api.addImage({dataUrl,name:`手机图片-${id.slice(0,8)}`});imported.set(id,node.id);
                }
                const node=await api.createH3({prompt:command.prompt,first:d.first?imported.get(d.first):undefined,last:d.last?imported.get(d.last):undefined,references:d.references.map(id=>imported.get(id)!),roleIds:d.roleIds,ultimateKeyframes:!!d.first,workflowOptionId:command.workflow==="dialogue"?"community-dialogue":"community-ultimate",duration:p.length/24,aspect:p.aspect,megapixels:p.megapixels,generationCount:1});
                sessionStorage.setItem(marker,node.id);
                result={...await api.generate(node.id),nodeId:node.id};
              }else if(command.kind==="runForNode" && command.nodeId){
                const runs=(await listRuns()).filter(r=>r.ownerNodeId===command.nodeId && r.createdAt >= (command.after??0)).sort((a,b)=>b.createdAt-a.createdAt);
                const run=runs[0];result=run?{comfyPromptId:run.comfyPromptId,status:run.status,error:run.error}:null;
              }else throw Error("不支持的桥接操作");
              processed.set(command.id,result);if(processed.size>100)processed.delete(processed.keys().next().value!);
            }
          }catch(cause){error=cause instanceof Error?cause.message:"画布操作失败";}
          await request("report",{commandId:command.id,result,error});
        }
      }catch{/* Offline agent is optional; never disrupt the canvas or log credentials. */}
      finally{inFlight=false;}
    };
    const wake=()=>void tick();
    const timer=setInterval(wake,4000);void tick();
    window.addEventListener("online",wake);
    window.addEventListener("focus",wake);
    return()=>{disposed=true;clearInterval(timer);window.removeEventListener("online",wake);window.removeEventListener("focus",wake);};
  },[]);
  return null;
}
