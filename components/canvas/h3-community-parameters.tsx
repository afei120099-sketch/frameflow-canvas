'use client';
import { communityControls, parseCommunityValues, UNDERSTANDING_VALUES, UNDERSTANDING_MEGAPIXELS, isUnderstandingPreset } from '@/lib/comfyui/experimental/h3-community-controls';
import type { CommunityWorkflowId } from '@/lib/h3-workflow-options';

export function H3CommunityParameters({id,value,onChange,onMegapixels,disabled}:{id:CommunityWorkflowId;value?:string;onChange:(value:string)=>void;onMegapixels?:(megapixels:number)=>void;disabled:boolean}) {
  const values=parseCommunityValues(value,id);
  const controls=communityControls(id);
  const save=(next:typeof values)=>{
    const root=value ? JSON.parse(value) : {};
    const map=('community-ultimate' in root || 'community-dialogue' in root) ? root : {};
    onChange(JSON.stringify({...map,[id]:next}));
  };
  const set=(key:string,next:string|number|boolean)=>save({...values,[key]:next});
  return <div style={{gridColumn:'1 / -1'}}>
    <p className="ff-hint">默认沿用原工作流。修改属于未试渲实验；改变输出 FPS 不会增加画面帧数，可能改变时长和音画同步。预览帧数 0 表示跟随任务。</p>
    <button type="button" disabled={disabled} onClick={()=>save({})}>恢复此工作流默认参数</button>
    {id==='community-ultimate' && <button type="button" disabled={disabled} className={isUnderstandingPreset(values)?'active':''} title="去掉 DMAD 加速 LoRA、25 步 res_multistep/simple、关闭稀疏注意力、像素预算 0.50MP；主模型不变。未试渲。" onClick={()=>{save({...UNDERSTANDING_VALUES}); onMegapixels?.(UNDERSTANDING_MEGAPIXELS);}}>🧪 理解优先（去加速LoRA · 25步 · 关稀疏 · 0.5MP）</button>}
    {[...new Set(controls.map(c=>c.group))].map(group=><details key={group} open={group==='采样'}><summary>{group}</summary><div className="professional-grid">
      {controls.filter(c=>c.group===group).map(c=><label key={c.key} title={`ComfyUI ${c.key}`}><span>{c.label}</span>{typeof c.value==='boolean' ? <input type="checkbox" checked={Boolean(values[c.key]??c.value)} disabled={disabled} onChange={e=>set(c.key,e.target.checked)}/> : c.options ? <select disabled={disabled} value={String(values[c.key]??c.value)} onChange={e=>set(c.key,e.target.value)}>{c.options.map(o=><option key={o}>{o}</option>)}</select> : <input disabled={disabled} type={typeof c.value==='number'?'number':'text'} min={c.min} max={c.max} step={c.integer?1:'any'} value={String(values[c.key]??c.value)} onChange={e=>{if(typeof c.value==='number'){if(e.target.value!=='' && Number.isFinite(e.target.valueAsNumber)) set(c.key,e.target.valueAsNumber);}else set(c.key,e.target.value);}}/>}</label>)}
    </div></details>)}
    <p className="ff-hint">模型、Text Encoder、VAE 和 LoRA 文件仍保留原配置；这里只调整执行参数，不下载或更换模型。连接关系、保存输出和文件路径由画布管理。模型尺寸须按32像素对齐。</p>
  </div>;
}
