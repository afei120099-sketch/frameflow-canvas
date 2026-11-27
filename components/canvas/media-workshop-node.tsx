"use client";
import {CulledShape} from './culled-shape';
import {useImageThumbnail} from './use-image-thumbnail';
import {useAcquiredMediaUrl} from './media-hooks';
import { useEffect, useRef, useState } from 'react';
import { BaseBoxShapeUtil, HTMLContainer, T, createShapeId, useValue, type Editor, type TLBaseShape } from 'tldraw';
import { Music2, Video, X } from 'lucide-react';
import { buildAudioLock, audioLockTiming, compileAudioLockPrompt } from '@/lib/comfyui/audio-lock';
import { LEGACY_H3_RETIRED_MESSAGE } from '@/lib/h3-workflow-options';
import { buildMusic3 } from '@/lib/comfyui/music3';
import { inspectMediaWorkflow, runMediaWorkflow, waitForMediaWorkflow, type MediaGraph } from '@/lib/comfyui/media-workflow-job';
import { readAudioDuration } from '@/lib/audio-metadata';
import { getAsset, registerAsset } from '@/lib/production-records';
import { getRole, listRoles, type RoleRecord } from '@/lib/role-records';
import { getLocalAudioBlob, getLocalImageBlob, storeLocalAudio, storeLocalVideo, readVideoMetadata } from '@/lib/local-video-store';
import { downloadSavedMedia } from '@/lib/media-download';
import {deleteCanvasNodes} from './safe-delete-action';
import {holdNodeTask} from '@/lib/node-task-activity';
import { showCanvasToast } from './canvas-events';
import { CopyPromptButton } from './copy-prompt-button';
import { calculateH3Dimensions, type H3Aspect } from '@/lib/comfyui/h3-parameters';

type Kind='audio-video-node'|'music-node';
type Take={src:string;assetId:string;name:string;duration:number;width:number;height:number;promptId:string;settings:string};
type Props={w:number;h:number;text:string;lyrics:string;seconds:number;start:number;aspect:string;megapixels:number;seed:string;instrumental:boolean;audioSrc:string;audioName:string;audioDuration:number;imageSrc:string;imageName:string;src:string;assetId:string;name:string;duration:number;resultWidth:number;resultHeight:number;pendingId:string;pendingSnapshot:string;stage:string;takes:Take[]};
type WorkshopNode=TLBaseShape<Kind,Props>;
declare module 'tldraw'{interface TLGlobalShapePropsMap{'audio-video-node':Props;'music-node':Props}}
const schema={w:T.number,h:T.number,text:T.string,lyrics:T.string,seconds:T.number,start:T.number,aspect:T.string,megapixels:T.number,seed:T.string,instrumental:T.boolean,audioSrc:T.string,audioName:T.string,audioDuration:T.number,imageSrc:T.string,imageName:T.string,src:T.string,assetId:T.string,name:T.string,duration:T.number,resultWidth:T.number,resultHeight:T.number,pendingId:T.string,pendingSnapshot:T.string,stage:T.string,takes:T.arrayOf(T.object({src:T.string,assetId:T.string,name:T.string,duration:T.number,width:T.number,height:T.number,promptId:T.string,settings:T.string}))};
const defaults=(music:boolean):Props=>({w:520,h:760,text:'',lyrics:'',seconds:music?30:5,start:0,aspect:'16:9',megapixels:.5,seed:'',instrumental:false,audioSrc:'',audioName:'',audioDuration:0,imageSrc:'',imageName:'',src:'',assetId:'',name:'',duration:0,resultWidth:0,resultHeight:0,pendingId:'',pendingSnapshot:'',stage:'就绪',takes:[]});
const active=new Set<string>();
function create(editor:Editor,type:Kind,point:{x:number;y:number},props:Partial<Props>={}){const id=createShapeId();editor.createShape({id,type,x:point.x-260,y:point.y-160,props});editor.select(id);editor.setCurrentTool('select');editor.zoomToSelection();return id;}
export function createAudioVideoNode(editor:Editor,point:{x:number;y:number}=editor.getViewportPageBounds().center,source?:{src:string;name:string;duration:number}){
 return create(editor,'audio-video-node',point,source?{audioSrc:source.src,audioName:source.name,audioDuration:source.duration,seconds:Math.min(15,Math.max(.2,Math.floor(source.duration*100)/100))}:{});
}
export function createMusicNode(editor:Editor,point:{x:number;y:number}=editor.getViewportPageBounds().center){return create(editor,'music-node',point);}
export class AudioVideoNodeUtil extends BaseBoxShapeUtil<TLBaseShape<'audio-video-node',Props>>{
 static override type='audio-video-node' as const;static override props=schema;
 override getDefaultProps(){return defaults(false);}override canResize(){return false;}
 override component(shape:TLBaseShape<'audio-video-node',Props>){return <CulledShape editor={this.editor} shapeId={shape.id}><WorkshopContent shape={shape} editor={this.editor}/></CulledShape>;}
 override getIndicatorPath(shape:TLBaseShape<'audio-video-node',Props>){const p=new Path2D();p.rect(0,0,shape.props.w,shape.props.h);return p;}
}
export class MusicNodeUtil extends BaseBoxShapeUtil<TLBaseShape<'music-node',Props>>{
 static override type='music-node' as const;static override props=schema;
 override getDefaultProps(){return defaults(true);}override canResize(){return false;}
 override component(shape:TLBaseShape<'music-node',Props>){return <CulledShape editor={this.editor} shapeId={shape.id}><WorkshopContent shape={shape} editor={this.editor}/></CulledShape>;}
 override getIndicatorPath(shape:TLBaseShape<'music-node',Props>){const p=new Path2D();p.rect(0,0,shape.props.w,shape.props.h);return p;}
}
function WorkshopContent({shape,editor}:{shape:WorkshopNode;editor:Editor}){
 const music=shape.type==='music-node',p=shape.props,title=music?'AI 作歌':'原音轨锁定视频',kind=music?'audio':'video',saveId=music?'9':'16';
 const [busy,setBusy]=useState(active.has(shape.id)),[checking,setChecking]=useState(false),[choosing,setChoosing]=useState(false),[error,setError]=useState(''),[modelState,setModelState]=useState('');
 const [roles,setRoles]=useState<RoleRecord[]>([]);
 const controller=useRef<AbortController|null>(null),selection=useRef(0),mounted=useRef(false);
 const selected=useValue('音画节点选择',()=>editor.getOnlySelectedShapeId()===shape.id,[editor,shape.id]);
 const mediaKey=useValue('当前画布音画素材',()=>{
  if(editor.getOnlySelectedShapeId()!==shape.id)return '';
  return editor.getCurrentPageShapes().flatMap(s=>{
   const q=s.props as {src?:string;name?:string;filename?:string};if(!q.src)return [];
   if(['audio-node','tts-node','music-node'].includes(s.type))return [[s.id,'audio',q.src,q.name||'声音'].join('\u0001')];
   if(['image-node','flux-image-node'].includes(s.type))return [[s.id,'image',q.src,q.name||q.filename||'图片'].join('\u0001')];return [];
  }).join('\u0002');
 },[editor,shape.id]);
 const media=mediaKey?mediaKey.split('\u0002').map(row=>{const [id,kind,src,name]=row.split('\u0001');return {id,kind,src,name};}):[];
 const patch=(props:Partial<Props>)=>{if(editor.getShape(shape.id))editor.updateShape({id:shape.id,type:shape.type,props});};
 const locked=busy||!!p.pendingId||choosing;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;selection.current++;controller.current?.abort();};},[]);
 useEffect(()=>{if(!selected||music)return;let live=true;void listRoles().then(data=>{if(live)setRoles(data);}).catch(cause=>{if(live)setError(String(cause));});return()=>{live=false;};},[selected,music]);
 const audioPreview=useAcquiredMediaUrl(p.audioSrc,selected),resultPreview=useAcquiredMediaUrl(p.src,selected);
 const imagePreview=useImageThumbnail(selected?p.imageSrc:'',480).url;
 const previews={audioSrc:p.audioSrc,imageSrc:p.imageSrc,src:p.src,audio:audioPreview,image:imagePreview,result:resultPreview};
 const choose=async(key:string,field:'audio'|'image')=>{
  if(locked)return;const token=++selection.current;setChoosing(true);setError('');
  try{
   if(!key){patch(field==='audio'?{audioSrc:'',audioName:'',audioDuration:0}:{imageSrc:'',imageName:''});return;}
   let item:{src:string;name:string}|undefined;
   if(key.startsWith('role:')){const role=await getRole(key.slice(5));const id=field==='audio'?role?.primaryVoiceAssetId:role?.primaryAppearanceAssetId;const asset=id?await getAsset(id):null;if(!asset||asset.kind!==field)throw new Error(field==='audio'?'该角色没有可用主声音':'该角色没有可用主外观');item={src:asset.storageReference,name:asset.filename};}
   else item=media.find(item=>item.id===key&&item.kind===field);
   if(!item)throw new Error('素材已不存在，请重新选择');
   const duration=field==='audio'?await readAudioDuration(await getLocalAudioBlob(item.src)):0;
   if(!mounted.current||token!==selection.current)return;
   patch(field==='audio'?{audioSrc:item.src,audioName:item.name,audioDuration:duration,start:0,seconds:Math.min(5,Math.max(.2,Math.floor(duration*100)/100))}:{imageSrc:item.src,imageName:item.name});
  }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'素材读取失败');}finally{if(mounted.current&&token===selection.current)setChoosing(false);}
 };
 const graph=(seed:number):MediaGraph=>music?buildMusic3({caption:p.text,lyrics:p.lyrics,seconds:p.seconds,seed,instrumental:p.instrumental}):buildAudioLock({prompt:p.text,audioName:p.audioName,imageName:p.imageSrc?p.imageName:undefined,start:p.start,seconds:p.seconds,audioDuration:p.audioDuration,aspect:p.aspect as Exclude<H3Aspect,'follow'>,megapixels:p.megapixels,seed});
 const checkModels=async()=>{
  if(!music){setModelState(LEGACY_H3_RETIRED_MESSAGE);return;}
  if(checking)return;setChecking(true);setModelState('检查中…');
  try{const sample=music?buildMusic3({caption:'availability check',lyrics:'',seconds:5,seed:0,instrumental:false}):buildAudioLock({prompt:'availability check',audioName:'pending.wav',start:0,seconds:5,audioDuration:15,aspect:'16:9',megapixels:.5,seed:0});const check=await inspectMediaWorkflow(sample);setModelState(check.errors.length?check.errors.join('\n'):'模型与节点已识别，可以生成');}catch(cause){setModelState(cause instanceof Error?cause.message:'连接失败');}finally{setChecking(false);}
 };
 const generate=async()=>{
  if(active.has(shape.id)||choosing)return;
  if(!music&&!p.pendingId){setError(LEGACY_H3_RETIRED_MESSAGE);return;}
  const recover=!!p.pendingId,seed=p.seed.trim()?Number(p.seed):crypto.getRandomValues(new Uint32Array(1))[0];let workflow:MediaGraph|undefined;
  try{if(!recover)workflow=graph(seed);}catch(cause){setError(cause instanceof Error?cause.message:'参数无效');return;}
  const current=new AbortController();controller.current=current;const releaseDeletion=holdNodeTask(shape.id);active.add(shape.id);setBusy(true);setError('');
  const snapshot=recover?p.pendingSnapshot:JSON.stringify({text:p.text,lyrics:p.lyrics,instrumental:p.instrumental,seconds:p.seconds,start:p.start,audioSrc:p.audioSrc,audioName:p.audioName,imageSrc:p.imageSrc,imageName:p.imageName,aspect:p.aspect,megapixels:p.megapixels,seed});
  const options={signal:current.signal,onStage:(stage:string)=>patch({stage}),onPending:(pendingId:string)=>patch({pendingId,pendingSnapshot:snapshot}),onRejected:()=>patch({pendingId:''})};
  try{
   const uploads=[];
   if(!recover&&!music){uploads.push({nodeId:'6',field:'audio',blob:await getLocalAudioBlob(p.audioSrc),name:p.audioName});if(p.imageSrc)uploads.push({nodeId:'20',field:'image',blob:await getLocalImageBlob(p.imageSrc),name:p.imageName});}
   const output=recover?await waitForMediaWorkflow(p.pendingId,saveId,kind,options):await runMediaWorkflow(workflow!,saveId,kind,uploads,options);
   if(!editor.getShape(shape.id))return;
   const metadata=music?null:await readVideoMetadata(output.blob),duration=music?await readAudioDuration(output.blob):Number.parseFloat(metadata!.duration);
   const src=music?await storeLocalAudio(output.blob,output.filename):await storeLocalVideo(output.blob,output.filename);
   const width=metadata?.width??0,height=metadata?.height??0;
   const asset=await registerAsset({kind,origin:'generated',filename:output.filename,mimeType:music?'audio/mpeg':'video/mp4',storageReference:src,sourceRunId:null,duration,fileSize:output.blob.size,...(!music?{width,height,fps:24}:{})});
   const owner=editor.getShape(shape.id) as WorkshopNode|undefined;if(!owner)return;
   const take={src,assetId:asset.assetId,name:output.filename,duration,width,height,promptId:output.promptId,settings:snapshot};
   patch({src,name:output.filename,assetId:asset.assetId,duration,resultWidth:width,resultHeight:height,pendingId:'',pendingSnapshot:'',stage:music?'作歌完成':'原音轨视频完成',takes:[...owner.props.takes,take]});
  }catch(cause){const message=current.signal.aborted?'已暂停查询，原任务可继续；点击查询原任务取回结果':cause instanceof Error?cause.message:'生成失败';setError(message);patch({stage:message});}
  finally{releaseDeletion();active.delete(shape.id);if(mounted.current)setBusy(false);if(controller.current===current)controller.current=null;}
 };
 const place=()=>{
  const type=music?'audio-node':'video-node';const existing=editor.getCurrentPageShapes().find(s=>s.type===type&&(s.props as {assetId?:string}).assetId===p.assetId);if(existing){editor.select(existing.id);editor.zoomToSelection();return;}
  const id=createShapeId(),w=music?330:540,h=music?155:Math.round(540*p.resultHeight/(p.resultWidth||960));
  if(music)editor.createShape({id,type:'audio-node',x:shape.x+p.w+100,y:shape.y,props:{w,h,src:p.src,name:p.name,duration:p.duration,assetId:p.assetId}});else editor.createShape({id,type:'video-node',x:shape.x+p.w+100,y:shape.y,props:{w,h,src:p.src,name:p.name,originalPath:p.name,duration:`${p.duration.toFixed(2)} 秒`,size:`${p.resultWidth}×${p.resultHeight}`,fps:24,assetId:p.assetId}});editor.select(id);
 };
 const picker=(field:'audio'|'image')=>{const src=field==='audio'?p.audioSrc:p.imageSrc,name=field==='audio'?p.audioName:p.imageName;return <label>{field==='audio'?'原声音频（Audio 1）':'人物／场景参考图（Picture 1，可选）'}<select aria-label={field==='audio'?'原音轨声音':'原音轨参考图'} disabled={locked} value={media.find(item=>item.kind===field&&item.src===src)?.id??(src?'saved':'')} onChange={e=>void choose(e.target.value,field)}>
  <option value="">{field==='audio'?'选择声音':'不使用参考图'}</option>{src&&!media.some(item=>item.kind===field&&item.src===src)&&<option value="saved">{name}（已绑定）</option>}
  <optgroup label="角色素材">{roles.map(role=><option key={role.roleId} value={`role:${role.roleId}`} disabled={field==='audio'?!role.primaryVoiceAssetId:!role.primaryAppearanceAssetId}>{role.displayName}</option>)}</optgroup>
  <optgroup label="当前画布素材">{media.filter(item=>item.kind===field).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>
 </select></label>;};
 const renderSize=calculateH3Dimensions(0,0,p.aspect as H3Aspect,p.megapixels,32);
 const snapshot=p.takes.find(take=>take.src===p.src)?.settings;
 return <HTMLContainer className="media-workshop-node" style={{width:p.w,height:p.h,pointerEvents:'all'}}>
  <header><strong>{music?<Music2 size={18}/>:<Video size={18}/>} {title}</strong><button type="button" disabled={locked} aria-label={`删除${title}节点`} onPointerDown={e=>e.stopPropagation()} onClick={()=>deleteCanvasNodes(editor,[shape.id])}><X size={16}/></button></header>
  <div className="workshop-controls" onPointerDown={e=>e.stopPropagation()} onPointerUp={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onContextMenu={e=>e.stopPropagation()}>
   <small className="ff-hint">{music?'MiniMax Music 3 · 30步 · 文本编码在CPU · 分块解码':'H3 · 固定原声 · 24 FPS · 口型效果待实测'}</small>
   <button type="button" disabled={checking||busy} onClick={()=>void checkModels()}>{checking?'检查中…':'检查模型与连接'}</button>{modelState&&<small className="model-check" role="status">{modelState}</small>}
   {!music&&<>{picker('audio')}{p.audioSrc&&<div><small>{p.audioName} · {p.audioDuration.toFixed(2)} 秒</small><audio aria-label="原音轨试听" controls preload="none" src={previews?.audioSrc===p.audioSrc?previews.audio||undefined:undefined}/></div>}{picker('image')}{p.imageSrc&&previews?.imageSrc===p.imageSrc&&<img className="workshop-reference" src={previews.image||undefined} alt="原音轨视频参考图" decoding="async"/>}</>}
   <label>{music?'歌曲／配乐描述':'视频画面描述'}<textarea aria-label={music?'作歌描述':'原音轨画面描述'} disabled={locked} value={p.text} onChange={e=>patch({text:e.target.value})} placeholder={music?'例如：温暖轻快的流行音乐，木吉他与钢琴，适合生活短片…':'描述场景、人物、动作和镜头；声音沿用上方原录音。可引用 <Audio 1> 和已添加的 <Picture 1>。'}/></label>
   <CopyPromptButton text={p.text}/>
   {music&&<><label className="workshop-checkbox"><input type="checkbox" aria-label="只生成纯音乐" checked={p.instrumental} disabled={locked} onChange={e=>patch({instrumental:e.target.checked})}/>纯音乐（不使用歌词）</label><label>歌词（可选）<textarea aria-label="作歌歌词" disabled={locked||p.instrumental} value={p.lyrics} onChange={e=>patch({lyrics:e.target.value})} placeholder="粘贴歌词，可用 [Verse]、[Chorus] 分段…"/></label><CopyPromptButton text={p.lyrics} label="复制全部歌词"/></>}
   <div className="workshop-fields">{!music&&<label>音频起点（秒）<input aria-label="原音轨起点" type="number" min={0} step={.01} disabled={locked} value={p.start} onChange={e=>patch({start:Number(e.target.value)})}/></label>}<label>{music?'最大时长（秒）':'视频时长（秒）'}<input aria-label={music?'作歌最大时长':'原音轨视频时长'} type="number" min={music?1:.2} max={music?360:15} step={music?1:.01} disabled={locked} value={p.seconds} onChange={e=>patch({seconds:Number(e.target.value)})}/></label><label>种子<input aria-label={music?'作歌种子':'原音轨种子'} disabled={locked} value={p.seed} onChange={e=>patch({seed:e.target.value})} placeholder="留空随机"/></label></div>
   {!music&&<div className="workshop-fields"><label>画面比例<select aria-label="原音轨画面比例" disabled={locked} value={p.aspect} onChange={e=>patch({aspect:e.target.value})}>{['16:9','9:16','1:1','4:3','3:4'].map(value=><option key={value}>{value}</option>)}</select></label><label>画质<select aria-label="原音轨像素预算" disabled={locked} value={p.megapixels} onChange={e=>patch({megapixels:Number(e.target.value)} )}><option value={.390625}>0.39 MP</option><option value={.5}>0.50 MP</option><option value={.87890625}>0.88 MP</option></select></label></div>}
   <small className={music?'ff-hint':undefined}>{music?'最大时长是上限，歌曲可能提前结束；生成的声音可用于配乐或原音轨视频。':`渲染尺寸 ${renderSize?.width??'—'}×${renderSize?.height??'—'} · ${p.megapixels.toFixed(2)} MP。选中区间音频作为最终原声；时长按24 FPS帧边界对齐。`}</small>
   <details><summary>生成信息</summary><small>{music?'输入：风格描述＋'+(p.instrumental?'纯音乐约束':'歌词'):`Audio 1 · ${p.audioName||'缺少原声音频'}${p.imageSrc?'\nPicture 1 · '+p.imageName:''}\n内部渲染 ${audioLockTiming(p.start,p.seconds).frames} 帧，输出约 ${audioLockTiming(p.start,p.seconds).outputSeconds.toFixed(2)} 秒`}</small>{!music&&<><CopyPromptButton text={compileAudioLockPrompt(p.text,!!p.imageSrc)}/><pre>{compileAudioLockPrompt(p.text,!!p.imageSrc)}</pre></>}{snapshot&&<><b>当前结果的实际参数</b><pre>{snapshot}</pre></>}</details>
   <div role="status" className="workshop-stage">{p.stage}</div>{error&&<p className="role-error" role="alert">{error}</p>}
   {!music&&<p className="workshop-error">{LEGACY_H3_RETIRED_MESSAGE}</p>}
   <div className="workshop-actions"><button type="button" className="ff-primary" disabled={(!music&&!p.pendingId)||busy||choosing||(!p.pendingId&&(!p.text.trim()||(!music&&!p.audioSrc)))} onClick={()=>void generate()}>{busy?'处理中…':p.pendingId?'查询原任务':music?'生成歌曲／配乐':'生成原音轨视频'}</button>{busy&&<button type="button" onClick={()=>controller.current?.abort()}>暂停查询</button>}{!busy&&p.pendingId&&p.stage.includes('不在队列或历史中')&&<button type="button" onClick={()=>{patch({pendingId:'',pendingSnapshot:'',stage:'失效任务记录已清除'});setError('');}}>清除失效任务记录</button>}</div>
   {p.src&&<section className="workshop-result"><strong>生成结果 · {p.duration.toFixed(2)} 秒</strong>{p.takes.length>1&&<select aria-label={`${title}版本`} disabled={busy} value={p.src} onChange={e=>{const take=p.takes.find(take=>take.src===e.target.value);if(take)patch({src:take.src,assetId:take.assetId,name:take.name,duration:take.duration,resultWidth:take.width,resultHeight:take.height});}}>{p.takes.map((take,i)=><option key={take.src} value={take.src}>版本 {i+1}</option>)}</select>}{music?<audio aria-label="作歌结果试听" controls preload="metadata" src={previews?.src===p.src?previews.result||undefined:undefined}/>:<video aria-label="原音轨视频播放" controls playsInline preload="metadata" src={previews?.src===p.src?previews.result||undefined:undefined}/>}
    <div className="workshop-actions"><button type="button" onClick={place}>{music?'放为声音节点':'放为视频节点'}</button><button type="button" onClick={()=>void downloadSavedMedia(p.src,p.name,kind).catch(cause=>showCanvasToast(String(cause)))}>下载</button></div>
   </section>}
  </div>
  <style>{`.media-workshop-node{box-sizing:border-box;background:var(--ff-control);color:var(--ff-text);border:1px solid var(--ff-border-strong);border-radius:16px;overflow:hidden}.media-workshop-node>header{display:flex;align-items:center;justify-content:space-between;padding:15px 18px;border-bottom:1px solid var(--ff-border-strong)}.media-workshop-node strong{display:flex;gap:8px;align-items:center}.workshop-controls{display:grid;gap:12px;padding:18px;box-sizing:border-box;max-height:700px;overflow:auto}.workshop-controls label{display:grid;gap:6px;font-size:13px}.workshop-controls input,.workshop-controls select,.workshop-controls textarea{box-sizing:border-box;width:100%;min-width:0;background:var(--ff-surface);border:1px solid var(--ff-border-strong);border-radius:8px;padding:9px;color:var(--ff-text);font:inherit}.workshop-controls textarea{height:110px;resize:vertical}.workshop-controls audio,.workshop-controls video{width:100%;margin-top:6px}.workshop-controls video{max-height:260px}.workshop-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.workshop-controls small,.workshop-stage{font-size:12px;color:var(--ff-text-2);overflow-wrap:anywhere;white-space:pre-wrap}.workshop-actions{display:flex;flex-wrap:wrap;gap:8px}.media-workshop-node button{border:1px solid var(--ff-border-strong);border-radius:8px;background:var(--ff-control);color:var(--ff-text);padding:9px 12px;cursor:pointer}.media-workshop-node button:disabled{opacity:.45;cursor:default}.workshop-result{display:grid;gap:8px;padding-top:12px;border-top:1px solid var(--ff-border-strong)}.workshop-reference{width:90px;height:80px;object-fit:contain}.workshop-checkbox{display:flex!important;align-items:center}.workshop-checkbox input{width:auto}.workshop-controls pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:220px;overflow:auto}.workshop-controls summary{cursor:pointer}`}</style>
 </HTMLContainer>;
}
