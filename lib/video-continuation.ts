import type { CapturedVideoFrame } from './video-frame-handoff.ts';
import { freezeH3Roles } from './h3-role-snapshot.ts';
import type { H3SoundMode } from './comfyui/h3-prompt.ts';

type Media = {src:string;name:string};
export interface ContinuationBindings {
  referenceImages?: Media[];
  referenceVideos?: (Media & {withAudio?:boolean})[];
  referenceAudios?: Media[];
  roleIds?: string[];
  voiceRoleId?: string;
  voiceRoleIds?: string[];
  autoVoiceDisabled?: boolean;
  offscreenRoleIds?: string[];
  roleSnapshot?: string;
  soundMode?: H3SoundMode;
  noBackgroundMusic?: boolean;
  promptMode?: string;
}
/** New shot: retain media/identity, not old dialogue, keyframes, prompts or Run ownership. */
export function tailVideoBindings(input:ContinuationBindings, references:Media[], frame:CapturedVideoFrame){
  const copy=structuredClone(input);
  let roleSnapshot:string|undefined;
  if(copy.roleSnapshot){
    const saved=JSON.parse(copy.roleSnapshot);
    if(saved.version!==1||!saved.data?.roles||!saved.data?.roleAssets)throw Error('原角色绑定快照损坏，请先核对来源节点');
    roleSnapshot=freezeH3Roles({...copy,roleIds:copy.roleIds??[],dialogue:[]},saved.data);
  }
  return {
    prompt:'',promptMode:copy.promptMode??'plain',dialogueLines:[],
    workflowOptionId:'community-ultimate',workflowLock:'queue-config-v2',
    ultimateKeyframes:true,allReferenceMode:true,hybridLock:false,
    videoFirstFrame:{...frame},videoLastFrame:undefined,inheritedLastFrame:undefined,
    sourceFrameSrc:'',sourceFrameName:'',sourceH3Id:'',extensionSourceVideo:undefined,
    referenceImages:structuredClone(references),referenceImageOrder:[],
    referenceVideos:copy.referenceVideos??[],referenceAudios:copy.referenceAudios??[],
    roleIds:copy.roleIds??[],voiceRoleId:copy.voiceRoleId,...(copy.voiceRoleIds?.length?{voiceRoleIds:[...copy.voiceRoleIds]}:{}),autoVoiceDisabled:copy.autoVoiceDisabled,offscreenRoleIds:copy.offscreenRoleIds??[],
    roleSnapshot,soundMode:copy.soundMode??'av',noBackgroundMusic:copy.noBackgroundMusic??false,
  };
}
