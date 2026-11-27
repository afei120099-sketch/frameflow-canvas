import ultimate from './h3-community-ultimate.json' with { type: 'json' };
import dialogue from './h3-community-dialogue.json' with { type: 'json' };
import type { CommunityWorkflowId } from '../../h3-workflow-options.ts';

export type CommunityValues = Record<string, string | number | boolean>;
type Control = { key: string; label: string; group: string; value: string | number | boolean; min?: number; max?: number; integer?: boolean; options?: string[] };
const groups: Record<string,string> = { '115':'画面', '123':'采样', '145':'采样', '147':'采样', '160':'采样', '177':'采样', '178':'采样', '181':'采样', '136':'参考素材', '156':'注意力加速', '165':'注意力加速', '150':'实时预览', '148':'输出编码' };
const labels: Record<string,string> = {
  format:'编码格式（MP4）',
  multiple:'分辨率步进', sampler_name:'采样器', strength_model:'DMAD LoRA 强度', sigmas:'Sigma 时间表（相邻数值间为一步）', scheduler:'基础调度器', steps:'基础步数 / 插值点数', denoise:'去噪强度', start_at_sigma:'插值起始 Sigma', end_at_sigma:'插值结束 Sigma', spacing:'插值间距', shift_video:'视频 Sigma 偏移', shift_audio:'音频 Sigma 偏移', ref_image_size:'参考图处理尺寸', attention:'密集注意力后端', 'selection.tau':'稀疏阈值 tau', start_percent:'稀疏开始比例', end_percent:'稀疏结束比例', dense_blocks:'保持密集计算的层', min_tokens:'启用稀疏的最低 Token 数', extra_tokens:'额外精确 Token 数', sink_conditioning:'文字 / 音频参考保护', verbose:'输出稀疏诊断日志', max_resolution:'预览最大边长', jpeg_quality:'预览 JPEG 质量', suppress_default_preview:'隐藏默认预览', preview_frames:'每步预览帧数', preview_fps:'预览帧率', tiny_vae:'预览解码器', frame_rate:'输出 FPS（不是插帧）', loop_count:'循环次数', pix_fmt:'输出像素格式', crf:'压缩质量 CRF（越小文件越大）', save_metadata:'保存生成元数据', trim_to_audio:'按音频长度裁剪', pingpong:'往返播放',
};
const options: Record<string,string[]> = {
  sampler_name:["euler","euler_cfg_pp","euler_ancestral","euler_ancestral_cfg_pp","heun","heunpp2","exp_heun_2_x0","exp_heun_2_x0_sde","dpm_2","dpm_2_ancestral","lms","dpm_fast","dpm_adaptive","dpmpp_2s_ancestral","dpmpp_2s_ancestral_cfg_pp","dpmpp_sde","dpmpp_sde_gpu","dpmpp_2m","dpmpp_2m_cfg_pp","dpmpp_2m_sde","dpmpp_2m_sde_gpu","dpmpp_2m_sde_heun","dpmpp_2m_sde_heun_gpu","dpmpp_3m_sde","dpmpp_3m_sde_gpu","ddpm","lcm","ipndm","ipndm_v","deis","cfgpp_ud10_ab","res_multistep","res_multistep_cfg_pp","res_multistep_ancestral","res_multistep_ancestral_cfg_pp","gradient_estimation","gradient_estimation_cfg_pp","er_sde","seeds_2","seeds_3","sa_solver","sa_solver_pece","ddim","uni_pc","uni_pc_bh2"],
  tiny_vae:['none','taef1_decoder.safetensors','taef1_encoder.safetensors','taeh3.safetensors','taesd_decoder.safetensors','taesd_encoder.safetensors','taesdxl_decoder.safetensors','taesdxl_encoder.safetensors'],
  format:['video/h264-mp4','video/h265-mp4'],
  scheduler:['simple','sgm_uniform','karras','exponential','ddim_uniform','beta','normal','linear_quadratic','kl_optimal'], spacing:['linear','cosine','sine'], ref_image_size:['match','max'], attention:['pytorch attention','comfy kitchen attention'], sink_conditioning:['exact_kv','exact_kv_and_rows','off'], pix_fmt:['yuv420p','yuv420p10le'],
  sigmas_source:['manual','scheduler'],
};

/** Ultimate only: which node feeds SamplerCustomAdvanced 125's sigmas. 'manual' = 147 ManualSigmas (frozen default), 'scheduler' = 160 BasicScheduler. */
export const SIGMAS_SOURCE_KEY = '125.sigmas_source';
/**
 * 🧪「理解优先」: H3's own cfg-free defaults (25 steps · res_multistep · simple, read from the
 * installed MiniMaxH3-Director profile) with the DMAD step-distill LoRA off and block-sparse attention
 * forced dense (min_tokens above any real token count). The base UNet is unchanged.
 * Not render-tested; trades sharpness/speed for prompt adherence. Pair with ~0.50MP.
 */
export const UNDERSTANDING_MEGAPIXELS = 0.5;
export const UNDERSTANDING_VALUES: Readonly<CommunityValues> = Object.freeze({
  '145.strength_model': 0,
  [SIGMAS_SOURCE_KEY]: 'scheduler',
  '160.scheduler': 'simple',
  '160.steps': 25,
  '123.sampler_name': 'res_multistep',
  '165.min_tokens': 1048576,
});
export function isUnderstandingPreset(values: CommunityValues) {
  const keys = Object.keys(UNDERSTANDING_VALUES);
  return Object.keys(values).length === keys.length && keys.every(k => values[k] === UNDERSTANDING_VALUES[k]);
}
const ranges: Record<string,[number,number,boolean?]> = { multiple:[32,256,true], strength_model:[-100,100], steps:[1,10000,true], denoise:[0,1], start_at_sigma:[-1,20000], end_at_sigma:[0,20000], shift_video:[.01,100], shift_audio:[.01,100], 'selection.tau':[0,4], start_percent:[0,1], end_percent:[0,1], min_tokens:[0,1048576,true], extra_tokens:[0,256,true], max_resolution:[0,8192,true], jpeg_quality:[30,100,true], preview_frames:[1,1024,true], preview_fps:[1,60,true], frame_rate:[1,120], loop_count:[0,100,true], crf:[0,100,true] };

/** All effective scalar tuning inputs; model assets and wiring are not parameter overrides.
 * 160 is disconnected in ultimate by default; its steps/scheduler only take effect when 125.sigmas_source = 'scheduler'.
 * Structural output flags stay owned by the canvas. */
export function communityControls(id: CommunityWorkflowId): Control[] {
  const template = (id === 'community-ultimate' ? ultimate : dialogue) as Record<string,{inputs:Record<string,unknown>}>;
  const result: Control[] = [];
  for (const [node,group] of Object.entries(groups)) {
    if (!template[node]) continue;
    for (const [field,value] of Object.entries(template[node].inputs)) {
      if (!labels[field] || !['string','number','boolean'].includes(typeof value)) continue;
      const range = ranges[field];
      if (node === '160' && field === 'denoise') continue;
      result.push({key:`${node}.${field}`,label:field === 'steps' ? node === '178' ? '插值点数（影响实际步数）' : '基础采样步数' : labels[field],group,value:value as string|number|boolean,min:range?.[0],max:node==='178' && field==='steps' ? 100 : range?.[1],integer:range?.[2],options:options[field]});
    }
  }
  if (id === 'community-ultimate') result.push({key:SIGMAS_SOURCE_KEY,label:'Sigma 来源（manual=147 手写时间表，scheduler=160 基础调度器）',group:'采样',value:'manual',options:options.sigmas_source});
  result.push({key:'150.preview_frames',label:labels.preview_frames,group:groups['150'],value:0,min:0,max:1024,integer:true}); // 0 follows task frame count
  return result;
}
export function parseCommunityValues(serialized?: string, id?: CommunityWorkflowId): CommunityValues {
  if (!serialized) return {};
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('专业参数格式无效');
  const map = value as Record<string,unknown>;
  if(id && ('community-ultimate' in map || 'community-dialogue' in map)) return (map[id] ?? {}) as CommunityValues;
  return value as CommunityValues;
}
export function validateCommunityValues(id: CommunityWorkflowId, values: CommunityValues) {
  const controls = communityControls(id);
  for (const [key,value] of Object.entries(values)) {
    const c = controls.find(c=>c.key===key);
    if (!c || typeof value !== typeof c.value) throw new Error(`专业参数无法识别：${key}`);
    if (typeof value === 'number' && (!Number.isFinite(value) || (c.min!==undefined && value<c.min) || (c.max!==undefined && value>c.max) || (c.integer && !Number.isInteger(value)))) throw new Error(`${c.label} 超出合法范围`);
    if (c.options && !c.options.includes(String(value))) throw new Error(`${c.label} 选项无效`);
    if (key==='115.multiple' && Number(value)%32) throw new Error('分辨率步进必须为32的倍数');
    if (key==='147.sigmas') {
      const sigmas=String(value).trim().split(/[\s,]+/).map(Number);
      if(sigmas.length<2 || sigmas.length>101 || sigmas.at(-1)!==0 || sigmas.some((v,i)=>!Number.isFinite(v)||v<0||(i>0 && v>=sigmas[i-1]))) throw new Error('Sigma 时间表须为递减非负数、以0结束，最多100步');
    }
  }
  const start=Number(values['165.start_percent'] ?? .2), end=Number(values['165.end_percent'] ?? 1);
  if(start>end) throw new Error('稀疏开始比例不能大于结束比例');
}
export function applyCommunityValues(id: CommunityWorkflowId, workflow: Record<string,{inputs:Record<string,unknown>}>, values: CommunityValues) {
  validateCommunityValues(id,values);
  for (const [key,value] of Object.entries(values)) {
    const separator=key.indexOf('.'), node=key.slice(0,separator), field=key.slice(separator+1);
    if(field==='preview_frames' && value===0) continue;
    if(key===SIGMAS_SOURCE_KEY){ if(value==='scheduler') workflow['125'].inputs.sigmas=['160',0]; continue; }
    workflow[node].inputs[field]=value;
  }
}
export function communityActualSteps(id: CommunityWorkflowId, values: CommunityValues): number | null {
  if(id==='community-ultimate' && values[SIGMAS_SOURCE_KEY]==='scheduler') return Number(values['160.steps'] ?? ultimate['160'].inputs.steps);
  if(id==='community-ultimate') return String(values['147.sigmas'] ?? ultimate['147'].inputs.sigmas).trim().split(/[\s,]+/).length-1;
  // ExtendIntermediateSigmas depends on actual scheduler values: do not invent the resulting count.
  return Object.keys(values).some(k=>k.startsWith('177.')||k.startsWith('178.')||k.startsWith('181.')) ? null : 5;
}
