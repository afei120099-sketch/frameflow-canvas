import {getAsset,registerAsset,putMeta,createRun,updateRun} from './production-records';
import {getLocalImageBlob,storeLocalImage} from './local-video-store';
import {runFluxDev,waitForFluxDev,FLUX_DEV_MODELS} from './comfyui/flux-dev';
import {runFluxKlein,KLEIN_MODELS} from './comfyui/flux-klein';
import {directorPrompt,pendingReview,type DirectorReference,type IdentityCard} from './cover-director';
import {COVER_SIZES,COVER_VERSION,coverKey,coverPrompt,coverRoles,coverActors,validateCover,type CoverDoc,type CoverTake} from './cover-model';
export type CpuResult={jobId:string;size:number[];files:string[];faces?:number[][];face?:number[];warning?:string;warnings?:string[];requiresVisualReview?:boolean;title?:unknown};
export async function coverCpu(plan:Record<string,unknown>):Promise<CpuResult>{
 const response=await fetch('/__cover/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(plan)});const data=await response.json() as CpuResult&{error?:string};if(!response.ok)throw Error(data.error??'封面CPU处理失败');return data;
}
export async function coverImage(id:string){const asset=await getAsset(id);if(!asset)throw Error('素材已丢失：'+id);return getLocalImageBlob(asset.storageReference);}
export async function coverData(id:string){const blob=await coverImage(id);return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('读取图片失败'));reader.readAsDataURL(blob);});}
async function saveBlob(blob:Blob,name:string,sourceIds:string[],runId:string|null=null){
 const src=await storeLocalImage(blob,name);let width=0,height=0;const image=await createImageBitmap(blob);width=image.width;height=image.height;image.close();
 return registerAsset({kind:'image',origin:'generated',filename:name,mimeType:'image/png',storageReference:src,sourceRunId:runId,width,height,fileSize:blob.size,sourceAssetIds:sourceIds});
}
async function saveFile(job:CpuResult,file:string,sources:string[]){const response=await fetch(`/__cover/jobs/${job.jobId}/${file}`);if(!response.ok)throw Error('封面输出读取失败');return saveBlob(await response.blob(),`Cover_${job.jobId}_${file}`,sources);}
export async function generateCover(doc:CoverDoc,id:string,notify:(doc:CoverDoc)=>void){
 const persist=async()=>{await putMeta(coverKey(id),doc);notify(structuredClone(doc));};
 const stage=async(text:string)=>{doc.stage=text;await persist();};
 if(!doc.work){validateCover(doc.spec);doc.work={spec:structuredClone(doc.spec),index:0,seed:doc.spec.seed.trim()?Number(doc.spec.seed):Math.floor(Math.random()*1e12),cutouts:[],runIds:[]};await persist();}
 const work=doc.work,spec=work.spec;const sources=spec.photos.map(p=>p.assetId);
 const director=spec.director?.enabled?spec.director:undefined;
 const plans=director?.selectedPlanIds?.length?director.plans.filter(p=>director.selectedPlanIds!.includes(p.id)):director?.plans;
 const currentPlan=()=>plans?.[work.index];
 const actualReferences=():DirectorReference[]=>[...coverRoles(spec).map((r,i)=>({image:i+1,assetId:r.photo.assetId,roleId:r.roleId,responsibility:'人物身份和服装；不控制构图'})),...(director&&work.guides?.[work.index]?[{image:coverRoles(spec).length+1,assetId:work.guides[work.index],responsibility:'仅构图、尺度、前后景、留白；不得覆盖身份'}]:[])];
 doc.error='';
 const gpu=async(phase:string,prompt:string,source?:string,mask?:string)=>{
  const phaseKey=`${work.index}:${phase}`;
  if(work.phaseResults?.[phaseKey])return work.phaseResults[phaseKey];
  if(work.stop)throw Error('已暂停；未自动取消ComfyUI中已提交的任务');
  const dims=spec.aspect==='9:16'?{width:576,height:1024}:spec.aspect==='3:4'?{width:768,height:1024}:{width:768,height:768};
  let result;
  const started=Date.now(),resumed=!!work.pendingId;
  let peak:number|null=null;let sampling=false;
  const sample=async()=>{if(sampling||!director)return;sampling=true;try{const response=await fetch('/__local_status',{signal:AbortSignal.timeout(2000)});const data=await response.json() as {gpu?:{vramUsedBytes?:number|null}};const bytes=data.gpu?.vramUsedBytes;if(typeof bytes==='number'&&Number.isFinite(bytes))peak=Math.max(peak??0,bytes/1048576);}catch{/* unknown is not zero */}finally{sampling=false;}};
  const timer=director?setInterval(()=>void sample(),2000):undefined;
  if(director)(work.actualPrompts??={})[work.index]=prompt;
  try{
  await sample();
  if(director&&!work.pendingId&&peak!==null&&peak>=15*1024)throw Error('当前显存占用已达15GB，未提交封面GPU任务；请先结束其它GPU工作。不会自动关闭程序或卸载模型。');
  if(work.pendingId){
   if(work.pendingStage!==phase)throw Error('恢复阶段不一致，请先查询原任务');
   await stage('查询原任务，不重复提交');result=await waitForFluxDev(work.pendingId,work.seed+work.index,{onStage:text=>notify({...structuredClone(doc),stage:text})});
  }else{
   await stage(phase);
   const callbacks={onStage:(text:string)=>notify({...structuredClone(doc),stage:text}),onReserved:async(promptId:string,graph:Record<string,unknown>)=>{
    const run=await createRun({capabilityId:'cover_generation',inputAssetIds:director?actualReferences().map(r=>r.assetId):sources,rawPrompt:spec.prompt,finalPrompt:prompt,seed:work.seed+work.index,ownerNodeId:doc.ownerNodeId,parameters:{spec,phase,...(director?{directorPlan:currentPlan(),referenceManifest:actualReferences()}:{}),models:spec.mode==='klein'?KLEIN_MODELS:FLUX_DEV_MODELS},workflowIdentity:{capabilityId:'cover_generation',templateVersion:COVER_VERSION,templateFile:spec.mode==='klein'?'native-klein-4b-edit':'programmatic-cover-v1'}});
    work.pendingRunId=run.runId;work.pendingId=promptId;work.pendingStage=phase;await putMeta('cover-workflow:'+run.runId,graph);await updateRun(run.runId,{comfyPromptId:promptId,submission:'reserved'});await persist();
   },onSubmitted:()=>{if(work.pendingRunId)void updateRun(work.pendingRunId,{status:'running',startedAt:Date.now(),submission:'accepted'});}};
   result=spec.mode==='klein'?await runFluxKlein({...dims,prompt,seed:work.seed+work.index},{...callbacks,images:await Promise.all((director?actualReferences().map(r=>r.assetId):coverRoles(spec).map(role=>role.photo.assetId)).map(id=>coverImage(id)))}):await runFluxDev({...dims,prompt,seed:work.seed+work.index,steps:24,denoise:mask ? .35 : source?spec.denoise:1,maskGrow:0,maskBlur:6},{...callbacks,sourceImage:source?await coverImage(source):undefined,maskImage:mask?await coverImage(mask):undefined});
  }
  }finally{if(timer)clearInterval(timer);await sample();if(director)(work.generationEvidence??={})[work.index]={wallMs:Date.now()-started,peakVramMiB:peak,resumed};}
  const asset=await saveBlob(result.image,`Cover_${phase}_${result.filename}`,sources,work.pendingRunId??null);
  if(work.pendingRunId){await updateRun(work.pendingRunId,{status:'completed',completedAt:Date.now(),outputAssetIds:[asset.assetId]});work.runIds.push(work.pendingRunId);}
  (work.phaseResults??={})[phaseKey]=asset.assetId;work.pendingId=undefined;work.pendingRunId=undefined;work.pendingStage=undefined;await persist();return asset.assetId;
 };
 const compose=async(backgroundId:string,actors:boolean,titleStyle=spec.titleStyle,allowBackgroundCast=false)=>{
  const size=COVER_SIZES[spec.aspect];return coverCpu({operation:'compose',fusion:spec.fusion,subtitle:spec.subtitle,allowBackgroundCast,size:[size.width,size.height],background:await coverData(backgroundId),actors:actors?await Promise.all(coverRoles(spec).map(async(role,roleIndex)=>{const cut=work.cutouts.find(c=>c.role===role.role)!;const actor=coverActors(spec,work.index)[roleIndex];return {...actor,image:await coverData(cut.assetId),face:cut.face};})):[],title:spec.title,titleStyle});
 };
 try{
  // All photos remain input Assets; only each role's chosen primary produces one actor layer.
  for(const role of director?[]:coverRoles(spec))if(!work.cutouts.some(c=>c.role===role.role)){
   await stage('BiRefNet CPU抠图（不占H3显存）：'+role.role);const job=await coverCpu({operation:'cutout',mattingMethod:spec.mattingMethod,image:await coverData(role.photo.assetId),alpha:role.photo.alphaAssetId?await coverData(role.photo.alphaAssetId):undefined});const asset=await saveFile(job,'cutout.png',[role.photo.assetId]);
   const alpha=job.files.includes('alpha.png')?await saveFile(job,'alpha.png',[role.photo.assetId]):undefined;
   const raw=job.files.includes('raw-cutout.png')?await saveFile(job,'raw-cutout.png',[role.photo.assetId]):undefined;
   const checks=[];for(const file of ['check-black.png','check-white.png','check-gray.png'])if(job.files.includes(file))checks.push((await saveFile(job,file,[role.photo.assetId])).assetId);
   work.cutouts.push({role:role.role,assetId:asset.assetId,face:job.face??[],alphaAssetId:alpha?.assetId,rawAssetId:raw?.assetId,checkAssetIds:checks});await putMeta('cover-cutout:'+asset.assetId,job);await persist();
  }
  while(work.index<spec.count){
   if(work.stop)throw Error('已暂停，结果和进度已保留');
   const plan=currentPlan();
   if(director&&plan&&!work.guides?.[work.index]){await stage('保存无字构图参考：'+plan.name);const guide=await coverCpu({operation:'director-guide',directorPlan:plan});(work.guides??={})[work.index]=(await saveFile(guide,'guide.png',sources)).assetId;await persist();}
   if(spec.mode==='klein'){
    if(!work.baseId)work.baseId=await gpu('Klein多参考编辑',director&&plan?directorPrompt(director,plan,coverRoles(spec),spec.prompt):coverRoles(spec).map((role,i)=>`Image ${i+1} owns ${role.role}'s identity and clothes only.`).join(' ')+' '+coverPrompt(spec,work.index).replace("The supplied composite defines each person's identity, clothing and position.","Preserve each independent reference identity and costume; do not merge faces. Relationships and poses may change within anatomical realism."));
    work.backgroundId=work.baseId;work.compositeId=work.baseId;
   }
   if(!work.backgroundId)work.backgroundId=await gpu('背景生成',coverPrompt(spec,work.index,true),spec.referenceAssetId||undefined);
   await persist();
   if(!work.compositeId){await stage('人物布局合成');const job=await compose(work.backgroundId,true);work.compositeId=(await saveFile(job,'base.png',sources)).assetId;work.maskId=(await saveFile(job,'repair-mask.png',sources)).assetId;await persist();}
   if(!work.baseId){
    if(spec.mode==='redraw')work.baseId=await gpu('电影重绘',coverPrompt(spec,work.index),work.compositeId);
    else if(spec.repair){const repaired=await gpu('背景局部修复',coverPrompt(spec,work.index,true),work.compositeId,work.maskId);const job=await compose(repaired,true,spec.titleStyle,true);work.baseId=(await saveFile(job,'base.png',sources)).assetId;}
    else work.baseId=work.compositeId;
    await persist();
   }
   await stage('中文标题合成');const effects=['gold','brush','cinema','metal','glow'] as const;
   const titleStyle=plan?{...spec.titleStyle,...plan.title}:work.index===0?spec.titleStyle:{...spec.titleStyle,effect:effects[work.index%5]};
   const faces=spec.mode==='preserve'?(await compose(work.backgroundId,true)).faces:undefined;
   const size=COVER_SIZES[spec.aspect];const job=await coverCpu({operation:'compose',subtitle:spec.subtitle,size:[size.width,size.height],background:await coverData(work.baseId),actors:[],faceBoxes:faces,title:spec.title,titleStyle});
   const base=await saveFile(job,'base.png',sources),title=await saveFile(job,'title.png',sources),final=await saveFile(job,'final.png',sources);
   if(spec.mode!=='preserve'&&job.faces?.length!==coverRoles(spec).length)(job.warnings??=[]).push(`人物数量核对未通过：检测到${job.faces?.length??0}张正脸、输入${coverRoles(spec).length}个角色；检测可能漏报侧脸或误报，须人工检查，不能当作合格封面`);
   const take:CoverTake={id:crypto.randomUUID(),createdAt:Date.now(),models:{...(spec.mode==='klein'?KLEIN_MODELS:FLUX_DEV_MODELS)},mode:spec.mode,seed:work.seed+(spec.candidateType==='titles'?0:work.index),prompt:coverPrompt(spec,spec.candidateType==='titles'?0:work.index),spec:{...structuredClone(spec),actors:coverActors(spec,work.index),titleStyle},baseAssetId:base.assetId,titleAssetId:title.assetId,finalAssetId:final.assetId,layerAssetIds:work.cutouts.flatMap(c=>[c.assetId,...(c.alphaAssetId?[c.alphaAssetId]:[]),...(c.rawAssetId?[c.rawAssetId]:[]),...(c.checkAssetIds??[])]),backgroundId:work.backgroundId,cutouts:structuredClone(work.cutouts),faceBoxes:job.faces??[],jobId:job.jobId,warnings:[...(job.warnings??[]),spec.mode==='preserve'?'BiRefNet／人工alpha：仍需检查发丝、衣领、面部与光线；原始照片保留，未改变原姿态':'AI重绘，身份、人数和服装均需人工验收'],runIds:[...work.runIds],workflowVersion:COVER_VERSION};
   if(director&&plan){
    const roles=coverRoles(spec),cards=await coverCpu({operation:'identity-cards',generated:await coverData(work.baseId),roles:await Promise.all(roles.map(async role=>({roleId:role.roleId,image:await coverData(role.photo.assetId),head:plan.actors.find(a=>a.roleId===role.roleId)!.head})))});
    const identityCards:IdentityCard[]=[];for(const [i,role] of roles.entries())identityCards.push({roleId:role.roleId,originalAssetId:(await saveFile(cards,`original-face-${i+1}.png`,sources)).assetId,generatedAssetId:(await saveFile(cards,`generated-face-${i+1}.png`,[work.baseId])).assetId,cropMethod:'生成脸按计划区域裁切，不是身份识别；若偏移请查看完整底图',traits:director.roles.find(r=>r.roleId===role.roleId)??{roleId:role.roleId,name:role.role,kind:'自定义',hair:'待人工观察',face:'待人工观察',features:'待人工观察',clothes:'参考原图',locked:'五官身份'},allowPose:director.allowPose,allowCostume:director.allowCostume});
    Object.assign(take,{directorPlan:structuredClone(plan),referenceManifest:actualReferences(),identityCards,review:pendingReview(roles.map(r=>r.roleId)),guideAssetId:work.guides![work.index],prompt:work.actualPrompts?.[work.index]??'',generationEvidence:work.generationEvidence?.[work.index]});
    take.warnings.push('未配置经验证的OCR／身份识别：须人工查看完整无字底图、人数、面部与标题。待验收，不能直接采用。');
   }
   doc.takes.push(take);work.index++;
   if(spec.candidateType==='layouts'){work.backgroundId=undefined;work.compositeId=undefined;work.baseId=undefined;work.maskId=undefined;}
   await persist();
  }
  doc.work=undefined;doc.error='';await stage('完成，请检查人物与抠图后采用');
 }catch(error){doc.error=error instanceof Error?error.message:String(error);doc.stage=work.pendingId?'原任务待核对（不会自动重投）':'处理停止，输入和历史已保留';await persist();throw error;}
}
/** CPU only. Preserve the selected take and append a new immutable editable version. */
export async function retitleCover(doc:CoverDoc,take:CoverTake,layout=false){
 const spec=doc.spec,size=COVER_SIZES[spec.aspect];
 if(layout&&take.mode!=='preserve')throw Error('AI重绘图人物已融入底图；改变人物布局需要重新AI生成');
 const actors=layout?await Promise.all(coverRoles(spec).map(async role=>{const cut=take.cutouts?.find(c=>c.role===role.role);if(!cut)throw Error('该角色没有已保存的抠图层，请重新生成');return {...role.actor,image:await coverData(cut.assetId),face:cut.face};})):[];
 const job=await coverCpu({operation:'compose',fusion:layout?spec.fusion:undefined,subtitle:spec.subtitle,size:[size.width,size.height],background:await coverData(layout?take.backgroundId!:take.baseAssetId),actors,faceBoxes:layout?undefined:take.faceBoxes,title:spec.title,titleStyle:take.directorPlan?{...spec.titleStyle,zone:take.directorPlan.title.zone,layout:take.directorPlan.title.layout}:spec.titleStyle});
 const source=[take.baseAssetId,...take.layerAssetIds];const base=await saveFile(job,'base.png',source),title=await saveFile(job,'title.png',source),final=await saveFile(job,'final.png',source);
 const next={...structuredClone(take),id:crypto.randomUUID(),createdAt:Date.now(),spec:structuredClone(spec),baseAssetId:base.assetId,titleAssetId:title.assetId,finalAssetId:final.assetId,faceBoxes:job.faces??[],jobId:job.jobId};doc.takes.push(next);if(next.directorPlan&&next.review)next.review.title='pending';else doc.adoptedId=next.id;return next;
}
