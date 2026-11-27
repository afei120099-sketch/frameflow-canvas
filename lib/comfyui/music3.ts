import type { MediaGraph } from './media-workflow-job.ts';
export const MUSIC3_MODELS={unet:'minimax_music3_dit_fp16.safetensors',clip:'minimax_music3_text_encoder_pruned_int8_convrot.safetensors',vae:'minimax_music3_dav.safetensors'};
export type MusicInput={caption:string;lyrics:string;seconds:number;seed:number;instrumental:boolean};
export function buildMusic3(input:MusicInput):MediaGraph{
 if(!input.caption.trim())throw new Error('请填写歌曲或配乐的风格描述');
 if(input.caption.length>12000||input.lyrics.length>12000)throw new Error('描述或歌词过长，请控制在12000字符内');
 if(!Number.isFinite(input.seconds)||input.seconds<1||input.seconds>360)throw new Error('作歌最大时长需为1到360秒');
 if(!Number.isSafeInteger(input.seed)||input.seed<0)throw new Error('种子需为非负安全整数');
 return {
  '1':{class_type:'UNETLoader',inputs:{unet_name:MUSIC3_MODELS.unet,weight_dtype:'default'}},
  '2':{class_type:'CLIPLoader',inputs:{clip_name:MUSIC3_MODELS.clip,type:'minimax',device:'cpu'}},
  '3':{class_type:'VAELoader',inputs:{vae_name:MUSIC3_MODELS.vae}},
  '4':{class_type:'MiniMaxMusic3TextEncode',inputs:{clip:['2',0],caption:input.caption.trim()+(input.instrumental?'\nInstrumental music only. No vocals, singing, speech or narration.':''),lyrics:input.instrumental?'':input.lyrics.trim(),seed:input.seed,max_duration:input.seconds,cfg_scale:1.7,top_k:50}},
  '5':{class_type:'ConditioningZeroOut',inputs:{conditioning:['4',0]}},
  '6':{class_type:'EmptyMiniMaxMusic3LatentAudio',inputs:{seconds:['4',1],batch_size:1}},
  '7':{class_type:'KSampler',inputs:{model:['1',0],positive:['4',0],negative:['5',0],latent_image:['6',0],seed:input.seed,steps:30,cfg:1.7,sampler_name:'euler',scheduler:'simple',denoise:1}},
  '8':{class_type:'VAEDecodeAudioTiled',inputs:{samples:['7',0],vae:['3',0],tile_size:1536,overlap:64}},
  '9':{class_type:'SaveAudioAdvanced',inputs:{audio:['8',0],filename_prefix:'audio/Frameflow_Music3',format:'mp3','format.quality':'V0'}},
 };
}
