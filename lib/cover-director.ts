/** CPU-only, editable poster planning. Never infer story facts or recognize identities. */
export type Box=[number,number,number,number];
export type Verdict='pending'|'pass'|'fail';
export type DirectorRole={roleId:string;name:string;kind:string;hair:string;face:string;features:string;clothes:string;locked:string};
export type PosterPlan={id:string;name:string;framing:string;gaze:string;background:string;light:string;relationship:string;actors:{roleId:string;weight:number;box:Box;head:Box;depth:number}[];title:{layout:'bottom'|'left'|'right'|'vertical';zone:Box;effect:'cinema'|'metal'|'brush'|'gold'|'glow'};evidence:string};
export type CoverDirector={enabled:boolean;story:string;goal:string;conflict:string;evidence:string;style:string;relationship:string;allowPose:boolean;allowCostume:boolean;roles:DirectorRole[];plans:PosterPlan[];confirmed?:string;selectedPlanIds?:string[]};
export type DirectorReview={identity:Record<string,Verdict>;identityNotes?:Record<string,string>;count:Verdict;noText:Verdict;relationship:Verdict;story:Verdict;hierarchy:Verdict;title:Verdict;notes:string;method:'manual-no-reliable-ocr'};
export type DirectorReference={image:number;assetId:string;roleId?:string;responsibility:string};
export type IdentityCard={roleId:string;originalAssetId:string;generatedAssetId:string;cropMethod:string;traits:DirectorRole;allowPose:boolean;allowCostume:boolean};
export function legacyRoleId(label:string){let n=2166136261;for(const c of label.trim()){n^=c.charCodeAt(0);n=Math.imul(n,16777619);}return 'legacy-role-'+(n>>>0).toString(16);}
export function defaultDirector():CoverDirector{return {enabled:true,story:'',goal:'',conflict:'',evidence:'',style:'写实电影海报',relationship:'对立',allowPose:true,allowCostume:false,roles:[],plans:[]};}
export function designPoster(d:CoverDirector,roles:{roleId:string;role:string}[]):PosterPlan[]{
 if(roles.length<1||roles.length>2)throw Error('导演三参考模式支持1～2个身份；3人已占满参考槽，不能再加独立构图图。旧Klein模式仍保留。');
 if(!d.story.trim()||!d.conflict.trim())throw Error('请先填写一句话剧情和核心冲突；系统不会替你编造剧情。');
 const actor=(i:number,weight:number,box:Box,head:Box,depth:number)=>({roleId:roles[i].roleId,weight,box,head,depth});
 const second=(a:ReturnType<typeof actor>)=>roles.length===2?[a]:[];
 const story=[d.story,d.goal&&'目标：'+d.goal,d.conflict&&'冲突：'+d.conflict].filter(Boolean).join('；');
 const common={relationship:d.relationship,evidence:d.evidence};
 const plans:PosterPlan[]=[
  {...common,id:'dominance',name:'A · 主角压迫式',framing:'主角近景大头像、次角后景半身',gaze:'主角直视观众；次角关注主角',background:'以纵深和收束光线体现权力差，剧情仅依据：'+story,light:'左侧硬主光与后景弱反光',actors:[actor(0,.76,[.03,.10,.70,.70],[.19,.15,.30,.24],3),...second(actor(roles.length-1,.24,[.68,.31,.29,.46],[.75,.34,.15,.13],1))],title:{layout:'bottom',zone:[.07,.81,.86,.16],effect:'cinema'}},
  {...common,id:'confrontation',name:'B · 双人情绪对峙',framing:'中近景、两人等权、沿中轴分离',gaze:roles.length===2?'两人相向凝视，明显眼神对峙':'主角向画面外的冲突方向凝视，不增加人物',background:'以左右空间分割呈现隔阂而非新增事件，剧情仅依据：'+story,light:'左右冷暖对分、面部曝光平衡',actors:[actor(0,.5,[.07,.08,.40,.62],[.14,.12,.23,.20],2),...second(actor(roles.length-1,.5,[.52,.08,.40,.62],[.62,.12,.23,.20],2))],title:{layout:'right',zone:[.79,.38,.19,.57],effect:'metal'}},
  {...common,id:'reversal',name:'C · 剧情反转式',framing:'环境中远景、信息差、主次身份视觉倒置',gaze:roles.length===2?'前景次角望向观众；后景主角越过次角观察线索':'人物背后的光暗空间与其视线形成信息差，不新增人物',background:(d.evidence?'前景突出用户提供的线索「'+d.evidence+'」，不在道具上生成文字；':'未提供道具：仅用明暗与前后景揭示身份信息差，不发明证据；')+'剧情仅依据：'+story,light:'后景轮廓光，前景局部中性光',actors:[actor(0,.3,[.49,.12,.29,.45],[.56,.16,.14,.13],1),...second(actor(roles.length-1,.7,[.33,.40,.65,.57],[.55,.44,.24,.21],3))],title:{layout:'vertical',zone:[.025,.20,.25,.68],effect:d.style.includes('古装')?'brush':'cinema'}},
 ];
 const relation=d.relationship;
 if(/保护/.test(relation)){
  plans[0].actors[0].box=[.03,.08,.72,.72];plans[0].background='前景角色遮护后景角色，主光落在保护者肩面；'+plans[0].background;
  plans[1].actors[0].box=[.08,.08,.55,.64];plans[1].actors[0].head=[.21,.13,.26,.20];if(plans[1].actors[1]){plans[1].actors[1].box=[.49,.20,.28,.46];plans[1].actors[1].head=[.57,.24,.15,.13];plans[1].actors[1].depth=1;}
  plans[1].gaze='保护者警觉望向画外，被保护者从后方望向保护者；用肩部遮护和前后距离表达关系';
 }else if(/恋人/.test(relation)){
  plans[1].gaze='两人相向、目光交汇，近而未接触的距离与柔和表情表达情感张力';plans[1].light='共享柔和主光，分割线保留但减少冷暖对立';
 }else if(/背叛|复仇|对立/.test(relation)){
  plans[1].gaze='两人分居左右，锐利视线交叉，肩线相互背离，以距离与冷暖断层表达不信任';
 }else if(/权力/.test(relation)){
  plans[1].actors[0].head[1]=.07;if(plans[1].actors[1])plans[1].actors[1].head[1]=.26;plans[1].title.zone=[.81,.50,.17,.45];plans[1].gaze='一方目光下压，另一方抬眼回应；头部高度差表达权力压制';
 }else if(/反转/.test(relation)){plans[2].gaze='前景角色视线越过观众，后景角色在较亮区域回望；以主次倒置暗示身份反转，不发明新事件';}
 if(!d.allowPose)for(const p of plans)p.gaze='保持每人原图头部及身体朝向；不强迫转身或转头。仅以'+p.framing+'及人物间距、明暗表达'+relation+'；原计划视线仅作叙事意图，不覆盖姿态锁。';
 return plans;
}
const overlap=(a:Box,b:Box)=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
export function validatePosterPlans(plans:PosterPlan[],roleIds:string[]){
 if(!Array.isArray(plans)||plans.length!==3||new Set(plans.map(p=>p.id)).size!==3)throw Error('须保存三个不同ID的导演方案');
 for(const p of plans){
  if(!p.name||!p.framing||!p.gaze||!p.background||!p.relationship||!p.light)throw Error('导演方案缺少叙事或镜头字段');
  if(!Array.isArray(p.actors)||p.actors.length!==roleIds.length||new Set(p.actors.map(a=>a.roleId)).size!==roleIds.length||p.actors.some(a=>!roleIds.includes(a.roleId)))throw Error('构图人物身份与参考清单不一致');
  if(!['bottom','left','right','vertical'].includes(p.title?.layout)||!['cinema','metal','brush','gold','glow'].includes(p.title?.effect))throw Error('标题布局或效果无效');
  for(const box of [p.title.zone,...p.actors.flatMap(a=>[a.box,a.head])])if(!Array.isArray(box)||box.length!==4||box.some(v=>!Number.isFinite(v)||v<0||v>1)||box[2]<=0||box[3]<=0||box[0]+box[2]>1.001||box[1]+box[3]>1.001)throw Error('构图区域需为画布内的归一化[x,y,w,h]');
  if(p.actors.some(a=>!Number.isFinite(a.weight)||a.weight<=0||a.weight>1||!Number.isFinite(a.depth)))throw Error('人物权重或前后层级无效');
  if(p.actors.some(a=>overlap(a.head,p.title.zone)>0))throw Error('标题预留区不能遮挡计划中的脸');
 }
 const axes=[(p:PosterPlan)=>p.actors.map(a=>a.weight),(p:PosterPlan)=>p.actors.map(a=>a.box),(p:PosterPlan)=>p.framing,(p:PosterPlan)=>p.gaze,(p:PosterPlan)=>p.background,(p:PosterPlan)=>p.title.zone];
 if(axes.some(axis=>new Set(plans.map(p=>JSON.stringify(axis(p)))).size<3))throw Error('三方案须在权重、位置、景别、视线、背景叙事和标题空间六项均有区别');
}
/** Exact snapshot, not a collision-prone hash. Any relevant edit invalidates confirmation. */
export function directorFingerprint(d:CoverDirector,photos:unknown){const {confirmed,selectedPlanIds,...input}=d;void confirmed;void selectedPlanIds;return JSON.stringify({input,photos});}
export function directorPrompt(d:CoverDirector,p:PosterPlan,roles:{roleId:string;role:string}[],extra=''){
 return roles.map((r,i)=>{const traits=d.roles.find(t=>t.roleId===r.roleId);return `Image ${i+1}: ONLY identity of ${r.role} [${r.roleId}], retain face shape, eyes/nose/mouth relationships, hair and age. ${traits?JSON.stringify(traits):''}`;}).join('\n')+`\nImage ${roles.length+1}: abstract composition ONLY, never borrow identity, costume, colors, simplified shapes or diagram style. Exactly ${roles.length} people, one per identity, no extras, no blended faces. No Chinese, English, letters, numerals, watermark, logo, signage, invented title or pseudo-glyphs anywhere. Real photographic poster artwork, not a diagram.\nUser-confirmed story ONLY: ${d.story}; goal: ${d.goal||'unspecified'}; conflict: ${d.conflict}; evidence: ${d.evidence||'none provided; invent no evidence prop'}. Style: ${d.style}. Relationship must be visually legible: ${d.relationship}. ${d.allowPose?'Pose may change anatomically; preserve identity.':'Keep original body pose and orientation; do not fabricate a turn.'} ${d.allowCostume?'Costume may change; identity must not.':'Keep original costume, fabric, color and accessories.'}\nConfirmed plan: ${JSON.stringify(p)}\nLeave title zone empty and calm; add NO typography. Additional user instructions (must not override identity/count/text rules): ${extra}`;
}
export function pendingReview(roleIds:string[]):DirectorReview{return {identity:Object.fromEntries(roleIds.map(id=>[id,'pending'])),count:'pending',noText:'pending',relationship:'pending',story:'pending',hierarchy:'pending',title:'pending',notes:'',method:'manual-no-reliable-ocr'};}
export function reviewStatus(r?:DirectorReview){if(!r)return 'PARTIAL';const values=[...Object.values(r.identity),r.count,r.noText,r.relationship,r.story,r.hierarchy,r.title];return values.includes('fail')?'FAIL':values.length>=7&&values.every(v=>v==='pass')?'PASS':'PARTIAL';}
export function canAdoptPoster(plan:PosterPlan,review?:DirectorReview){return !!review&&reviewStatus(review)==='PASS'&&plan.actors.every(a=>review.identity[a.roleId]==='pass');}
