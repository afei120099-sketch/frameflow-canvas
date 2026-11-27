import type { MediaGraph } from './media-workflow-job.ts';
import { calculateH3Dimensions, type H3Aspect } from './h3-parameters.ts';
import { promptTagErrors } from '../shot-prompt-checks.ts';
export const AUDIO_LOCK_MODELS={unet:'minimax_h3_fl2va_pruned_int8_convrot.safetensors',clip:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',videoVae:'minimax_h3_video_vae_fp16.safetensors',audioVae:'minimax_h3_audio_vae_fp32.safetensors',lora:'minimax_h3_turbo_v4_step600_ema.safetensors'};
export type AudioLockInput={prompt:string;audioName:string;imageName?:string;start:number;seconds:number;audioDuration:number;aspect:Exclude<H3Aspect,'follow'>;megapixels:number;seed:number};
export function audioLockTiming(start:number,seconds:number){
 const minimum=124/24,extra=Math.max(0,minimum-seconds),trim=extra/2;
 const frames=5+17*Math.max(0,Math.ceil((Math.ceil(Math.max(minimum,seconds)*24-1e-9)-5)/17));
 return {frames,renderSeconds:frames/24,trimStart:trim,sourceStart:start,outputSeconds:Math.round(seconds*24)/24};
}
export function compileAudioLockPrompt(prompt:string,hasImage:boolean){
 return [
  'subject_definitions:\n<Audio 1> is the supplied source recording.'+(hasImage?'\n<Picture 1> is the supplied visual reference.':''),
  'summary:\n[audio reuse + reference generation] Generate the requested visuals while keeping the supplied recording.',
  'retention_analysis:\n<Audio 1>: fully_copy - keep the source words, voice, delivery, rhythm and timing.'+(hasImage?'\n<Picture 1>: attribute_transfer - retain the supplied subject appearance and scene look as requested.':''),
  'detailed_description:\n[Shot 1] '+prompt.trim(),
  'overall_soundscape:\nUse the supplied <Audio 1> recording as the final soundtrack. Do not invent, translate or replace its speech or singing.',
  'non_diegetic_music:\nN/A',
 ].join('\n\n');
}
export function buildAudioLock(input:AudioLockInput):MediaGraph{
 if(!input.prompt.trim())throw new Error('请填写视频画面描述');
 if(input.prompt.length>12000)throw new Error('画面描述过长，请控制在12000字符内');
 if(!input.audioName)throw new Error('请选择要保留原声的声音素材');
 if(!Number.isFinite(input.seconds)||input.seconds<.2||input.seconds>15||!Number.isFinite(input.start)||input.start<0)throw new Error('音频起点需大于等于0，视频时长需为0.2到15秒');
 if(!Number.isFinite(input.audioDuration)||input.audioDuration<=0||input.start+input.seconds>input.audioDuration+.01)throw new Error('所选音频长度不足，请缩短时长或调整起点');
 if(!Number.isSafeInteger(input.seed)||input.seed<0)throw new Error('种子需为非负安全整数');
 if(!Number.isFinite(input.megapixels)||input.megapixels<.3||input.megapixels>1)throw new Error('像素预算需为0.30到1.00 MP');
 const size=calculateH3Dimensions(0,0,input.aspect,input.megapixels,32);if(!size)throw new Error('请选择明确的视频比例');
 const errors=promptTagErrors(input.prompt,{subjects:0,pictures:input.imageName?1:0,audios:1,videos:0,standaloneAudios:1});if(errors.length)throw new Error(errors.join('；'));
 const timing=audioLockTiming(input.start,input.seconds);
 if(timing.frames>362)throw new Error('对齐后超过单镜头帧数上限，请缩短时长');
 const graph:MediaGraph={
  '1':{class_type:'UNETLoader',inputs:{unet_name:AUDIO_LOCK_MODELS.unet,weight_dtype:'default'}},
  '2':{class_type:'CLIPLoader',inputs:{clip_name:AUDIO_LOCK_MODELS.clip,type:'minimax',device:'default'}},
  '3':{class_type:'VAELoader',inputs:{vae_name:AUDIO_LOCK_MODELS.videoVae}},
  '4':{class_type:'VAELoader',inputs:{vae_name:AUDIO_LOCK_MODELS.audioVae}},
  '5':{class_type:'MiniMaxH3TurboLoRA',inputs:{model:['1',0],lora_name:AUDIO_LOCK_MODELS.lora,strength:1,low_vram:false}},
  '6':{class_type:'LoadAudio',inputs:{audio:input.audioName}},
  '7':{class_type:'MiniMaxH3AudioWindowT8',inputs:{audio:['6',0],scene_start_seconds:input.start,scene_duration_seconds:input.seconds,warmup_seconds:0,cooldown_seconds:0,ensure_minimum_context:true}},
  '8':{class_type:'MiniMaxH3AudioConditioningT8',inputs:{clip:['2',0],video_vae:['3',0],audio_vae:['4',0],drive_audio:['7',0],prompt:compileAudioLockPrompt(input.prompt,!!input.imageName),width:size.width,height:size.height,length:['7',1],task_type:'Ref2VA',audio_mode:'lock_source',audio_denoise_strength:0,add_source_as_reference:true,prompt_primary_audio_ordinal:0,strict_prompt_tags:true,ref_image_size:'match',reference_video_policy:'official_2_to_15s',allow_above_reference_area:false}},
  '9':{class_type:'MiniMaxH3DualClockSamplerT8',inputs:{model:['5',0],av_latent:['8',1],steps:4,shift_video:12,shift_audio:3,sampler_name:'dual_clock_euler',scheduler:'native_flow'}},
  '10':{class_type:'BasicGuider',inputs:{model:['9',0],conditioning:['8',0]}},
  '11':{class_type:'RandomNoise',inputs:{noise_seed:input.seed}},
  '12':{class_type:'SamplerCustomAdvanced',inputs:{noise:['11',0],guider:['10',0],sampler:['9',1],sigmas:['9',2],latent_image:['8',1]}},
  '13':{class_type:'MiniMaxH3AVDecodeT8',inputs:{av_latent:['12',0],video_vae:['3',0],audio_vae:['4',0]}},
  '14':{class_type:'MiniMaxH3OutputTrimT8',inputs:{frames:['13',0],audio:['8',2],start_seconds:['7',2],duration_seconds:['7',3],fps:24}},
  '15':{class_type:'CreateVideo',inputs:{images:['14',0],audio:['14',1],fps:24,bit_depth:8,color_space:'sRGB'}},
  '16':{class_type:'SaveVideo',inputs:{video:['15',0],filename_prefix:'video/Frameflow_AudioLock',format:'auto','format.codec':'auto',codec:'auto'}},
 };
 if(input.imageName){graph['20']={class_type:'LoadImage',inputs:{image:input.imageName}};graph['8'].inputs['ref_images.ref_image_0']=['20',0];}
 return graph;
}
