import type { RunRecord } from "./production-records.ts";
import { lockedWorkflow, captureWorkflow } from "./locked-generation.ts";
import { buildCommunityWorkflow } from "./comfyui/experimental/h3-community.ts";
import {freezeH3Roles} from "./h3-role-snapshot.ts";
import type { H3GenerationSettings } from "./ai-adapter.ts";
export const TOOLKIT_EVENT = "frameflow-canvas-toolkit";
export const PROMPT_LIBRARY_KEY = "prompt-library-v1";
export const NODE_TEMPLATES_KEY = "node-templates-v1";
export interface PromptSnippet { id:string; name:string; category:string; text:string }
export const BUILTIN_SNIPPETS:PromptSnippet[]=[
 ["bgm","禁 BGM","声音","Audible audio is room tone, the lines already written, and the action sounds already described."],
 ["worker","工人不是主持人","角色","The workers are background construction workers, not the host or narrator. They do not address the camera."],
 ["voice","音色参考","声音","Use the selected speaker's supplied audio reference for voice identity; preserve its timbre and accent."],
 ["steady","平稳无抖动","镜头","Stable camera movement with smooth acceleration and deceleration; no unintended handheld shake."],
 ["offscreen","画外音","声音","The narrator speaks off-screen and never appears in the image. No visible character speaks these lines."]
].map(([id,name,category,text])=>({id:"builtin:"+id,name,category,text}));
export function insertSnippet(value:string,text:string,start=value.length,end=start){return value.slice(0,start)+text+value.slice(end);}
export function cleanTemplateContent<T>(content:T):T {
 const copy=structuredClone(content) as T & {shapes?:{type:string;props:Record<string,unknown>;meta?:Record<string,unknown>}[]};
 for(const shape of copy.shapes??[]){
   shape.meta={};
   const p=shape.props;
   if("autoStart" in p)p.autoStart=false;
   for(const key of ["shotId","runId","previewAssetId","lockedRunId","lockedAssetId","pendingId","lastSubmittedPrompt","lastSubmittedSeed","sourceH3Id","sourceNodeId"])delete p[key];
   if(["h3-node","flux-image-node","tts-node","music-node","audio-video-node"].includes(shape.type)){
     for(const key of ["candidates","adoptedAssetId","inheritedVideo","roleSnapshot"])delete p[key];
     if(shape.type!=="h3-node"){
       for(const key of ["src","assetId","filename","pendingSnapshot"])if(key in p)p[key]="";
       p.pendingId="";
       if("takes" in p)p.takes=[];
       if("duration" in p)p.duration=0;
       p.stage="就绪";
     }
   }
   for(const key of ["videoFirstFrame","videoLastFrame"])if(p[key]&&typeof p[key]==="object")p[key]={...p[key] as object,sourceNodeId:""};
   if("workflowLock" in p)p.workflowLock="queue-config-v2";
 }
 return copy;
}
/** Rebuild sampling only, never resolve shared role data again. */
export async function promotionSnapshot(run:RunRecord){
 if(run.parameters.workflowOptionId!=="community-dialogue")throw Error("仅极速版成功候选可转正");
 const old=await lockedWorkflow(run),p=run.parameters;
 const images=Object.entries(old.graph).filter(([id])=>id.startsWith("ff-community-image-")).sort(([a],[b])=>Number(a.split("-").at(-1))-Number(b.split("-").at(-1))).map(([,n])=>String(n.inputs.image));
 const audios=Object.entries(old.graph).filter(([id])=>/^ff-community-audio-\d+$/.test(id)).sort(([a],[b])=>Number(a.split("-").at(-1))-Number(b.split("-").at(-1))).map(([,n])=>String(n.inputs.audio));
 const conditioning=old.graph["136"];
 if(!conditioning)throw Error("候选缺少条件节点快照，不能转正");
 const settings:H3GenerationSettings={length:Number(p.length),aspect:"follow",megapixels:Number(p.megapixels),turbo:true,steps:10,fps:24,loraStrength:.75,upscaleMethod:"lanczos",resolutionSteps:32,soundMode:(p.soundMode as H3GenerationSettings["soundMode"])??"av",...(old.graph["ff-community-audio-0-trim"]?{referenceAudioTrimSeconds:Number(old.graph["ff-community-audio-0-trim"].inputs.duration)}:{})};
 const graph=buildCommunityWorkflow("community-ultimate",images,run.finalPrompt!,run.seed!,settings,Number(conditioning.inputs.width),Number(conditioning.inputs.height),p.communityKeyframes as {first?:number;last?:number}|undefined,audios);
 graph["136"]=structuredClone(conditioning);
 if(!old.graph["148"].inputs.audio)delete graph["148"].inputs.audio;
 return captureWorkflow(graph,"148");
}


/** Restore form bindings from the chosen candidate, not the current role library. */
export function promotedNodeProps(run:RunRecord){
 const m=run.referenceManifest;
 if(!m)throw Error("旧试片缺少参考绑定快照，不能恢复节点参数");
 const frames=run.parameters.communityKeyframes as {first?:number;last?:number}|null;
 const keyIndices=[frames?.first,frames?.last].filter((n):n is number=>n!==undefined);
 const frame=(n:number|undefined)=>{const p=n?m.pictureRefs[n-1]:null;return p?{src:p.storageReference,name:p.filename,sourceNodeId:""}:undefined;};
 const roleIds=m.roleBindings.map(r=>r.roleId),dialogue=m.dialogue.map(d=>({roleId:d.roleId,text:d.text,...(!d.roleId?{speaker:d.speaker,voice:d.voice??'none'}:{})}));
 const roles=m.roleBindings.map(r=>({roleId:r.roleId,displayName:r.roleName,description:r.description,appearanceAssetIds:r.appearanceAssetIds,voiceAssetIds:r.voiceAssetIds,primaryAppearanceAssetId:r.selectedAppearanceAssetId,primaryVoiceAssetId:r.selectedVoiceAssetId}));
 const roleAssets=Object.fromEntries([...m.pictureRefs.map(p=>({...p,kind:"image" as const})),...m.audioRefs.filter(a=>a.kind==="standalone").map(a=>({...a,kind:"audio" as const}))].map(a=>[a.assetId,{assetId:a.assetId,kind:a.kind,storageReference:a.storageReference,filename:a.filename}]));
 const selection={roleIds,voiceRoleId:m.voiceRoleId,...(m.voiceRoleIds?.length?{voiceRoleIds:m.voiceRoleIds}:{}),offscreenRoleIds:m.offscreenRoleIds??[],dialogue};
 return {
  workflowOptionId:"community-ultimate",workflowLock:"queue-config-v2",communityParameters:undefined,steps:10,loraStrength:.75,turbo:true,fps:24,
  upscaleMethod:String(run.parameters.upscaleMethod??"lanczos"),resolutionSteps:Number(run.parameters.resolutionSteps??32),lockedRunId:undefined,lockedAssetId:undefined,
  prompt:run.rawPrompt??run.finalPrompt??"",promptMode:run.promptMode??"plain",seedMode:"固定",seed:String(run.seed),generationCount:1,
  mode:String(run.parameters.aspectRatio??"16:9"),megapixels:Number(run.parameters.megapixels),duration:String(Number(run.parameters.length)/24),soundMode:m.soundMode,
  noBackgroundMusic:run.parameters.noBackgroundMusic===true,autoVoiceDisabled:run.parameters.autoVoiceDisabled===true,roleIds,voiceRoleId:m.voiceRoleId,...(m.voiceRoleIds?.length?{voiceRoleIds:[...m.voiceRoleIds]}:{}),offscreenRoleIds:m.offscreenRoleIds??[],dialogueLines:dialogue,
  roleSnapshot:freezeH3Roles(selection,{roles,roleAssets,missingRoleIds:[]}),
  referenceImages:m.pictureRefs.filter(p=>!keyIndices.includes(p.index)&&p.sources.some(source=>source!=="role_appearance")).map(p=>({src:p.storageReference,name:p.filename})),
  referenceImageOrder:[],referenceAudios:m.audioRefs.filter(a=>a.kind==="standalone"&&a.sources.includes("reference_audio")).map(a=>({src:a.storageReference,name:a.filename})),
  referenceVideos:m.videoRefs.map(v=>({src:v.storageReference,name:v.filename,withAudio:v.withAudio})),allReferenceMode:!!(m.pictureRefs.length||m.audioRefs.length||m.videoRefs.length),
  videoFirstFrame:frame(frames?.first),videoLastFrame:frame(frames?.last),ultimateKeyframes:!!frames,hybridLock:false,
  inheritedLastFrame:undefined,sourceFrameSrc:"",sourceFrameName:"",sourceH3Id:"",extensionSourceVideo:undefined,
  lastSubmittedPrompt:run.finalPrompt??"",lastSubmittedSeed:run.seed??undefined,
 };
}
