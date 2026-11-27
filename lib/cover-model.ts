/** Cover V1 data is stored in the existing production meta store (included in project backups). */
import {legacyRoleId,validatePosterPlans,directorFingerprint,type CoverDirector,type PosterPlan,type DirectorReview,type DirectorReference,type IdentityCard} from './cover-director.ts';
export const COVER_VERSION='cover-v2.1';
export const COVER_TEMPLATES={
 hero:{name:'单人主角海报',positions:[[.5,1.12,1.25,3],[.78,1.05,.77,1],[.2,1.05,.7,0]],light:'left',scene:'one meaningful doorway behind the protagonist, strong central hierarchy',title:'cinema'},
 confrontation:{name:'男女主情绪对峙',positions:[[.28,1.10,1.12,3],[.77,1.04,1.0,2],[.5,.92,.62,0]],light:'right',scene:'a divided interior with opposing cool window light and warm practical light; tension expressed by separation, preserve original body poses',title:'cinema'},
 depth:{name:'双人前后层次',positions:[[.29,1.13,1.22,3],[.74,1.03,.91,1],[.82,.9,.65,0]],light:'left',scene:'a foreground doorway framing a distant city window, clear foreground and middle-ground hierarchy',title:'metal'},
 triangle:{name:'三人关系冲突',positions:[[.5,1.14,1.20,4],[.16,1.04,.83,1],[.85,1.06,.90,2]],light:'left',scene:'triangular cast hierarchy, closed door behind the principal figure, restrained asymmetrical architectural lines',title:'cinema'},
 revenge:{name:'都市豪门复仇',positions:[[.35,1.14,1.25,4],[.8,1.05,.92,1],[.15,1.02,.7,0]],light:'left',scene:'a restrained contemporary penthouse, dark stone doorway, distant city window, a single open contract folder on an empty desk; charcoal and ivory palette',title:'metal'},
 xianxia:{name:'古装仙侠',positions:[[.37,1.11,1.15,3],[.78,1.04,.91,1],[.15,1.02,.72,0]],light:'right',scene:'an empty moonlit palace gate and distant mountains; slate blue and restrained warm lantern light; preserve supplied costume without inventing new actor poses',title:'brush'},
 fantasy:{name:'玄幻逆袭',positions:[[.5,1.15,1.23,3],[.84,1.07,.8,1],[.13,1.02,.75,0]],light:'left',scene:'an empty ancient threshold opening toward immense sky and stone architecture, a single restrained light shaft; keep effects subordinate to faces',title:'gold'},
 crime:{name:'悬疑犯罪',positions:[[.31,1.13,1.21,3],[.8,1.03,.9,1],[.17,1.01,.66,0]],light:'right',scene:'an empty rain-streaked office window and partially open door, a closed evidence envelope on a desk, blue gray low saturation with one warm practical',title:'cinema'},
} as const;
export type CoverTemplate=keyof typeof COVER_TEMPLATES;
export const COVER_SIZES={'9:16':{width:1080,height:1920},'3:4':{width:1080,height:1440},'1:1':{width:1080,height:1080}} as const;
export const COVER_STYLES={cinema:'电影剧情',romance:'都市情感',thriller:'悬疑冲突',historical:'古装传奇'} as const;
export const TITLE_EFFECTS={gold:'金色倒角',metal:'冷银金属',brush:'毛笔书法（马善政）',cinema:'现代电影',glow:'发光艺术字'} as const;
export type CoverPhoto={assetId:string;role:string;roleId?:string;primary:boolean;alphaAssetId?:string};
export type CoverActor={role:string;priority:number;x:number;y:number;scale:number;z:number;fullBody?:boolean};
export type CoverTitle={font:'sans'|'serif';effect:keyof typeof TITLE_EFFECTS;layout:'auto'|'top'|'bottom'|'left'|'right'|'vertical'|'manual';zone?:[number,number,number,number];size:number;x:number;y:number;lineHeight:number;tracking:number};
export type CoverSpec={director?:CoverDirector;title:string;subtitle?:string;template?:CoverTemplate;mattingMethod?:'birefnet'|'grabcut';fusion?:{protection:'pixels'|'identity';lightDirection:'left'|'right';warmth:number;exposure:number;grain:boolean;depth:boolean};synopsis:string;prompt:string;mode:'preserve'|'redraw'|'klein';style:keyof typeof COVER_STYLES;aspect:keyof typeof COVER_SIZES;candidateType:'layouts'|'titles';count:number;photos:CoverPhoto[];actors:CoverActor[];referenceAssetId:string;seed:string;denoise:number;repair:boolean;titleStyle:CoverTitle};
export type CoverTake={directorPlan?:PosterPlan;referenceManifest?:DirectorReference[];identityCards?:IdentityCard[];review?:DirectorReview;guideAssetId?:string;generationEvidence?:{wallMs:number;peakVramMiB:number|null;resumed:boolean};id:string;createdAt:number;mode:CoverSpec['mode'];seed:number;prompt:string;spec:CoverSpec;models?:Record<string,string>;lora?:{name:string;strength:number};baseAssetId:string;titleAssetId:string;finalAssetId:string;layerAssetIds:string[];backgroundId?:string;cutouts?:CoverWork['cutouts'];faceBoxes:number[][];jobId:string;warnings:string[];runIds:string[];workflowVersion:string};
export type CoverWork={guides?:Record<number,string>;actualPrompts?:Record<number,string>;generationEvidence?:Record<number,{wallMs:number;peakVramMiB:number|null;resumed:boolean}>;spec:CoverSpec;index:number;seed:number;cutouts:{role:string;assetId:string;face:number[];alphaAssetId?:string;rawAssetId?:string;checkAssetIds?:string[]}[];phaseResults?:Record<string,string>;backgroundId?:string;compositeId?:string;baseId?:string;maskId?:string;pendingId?:string;pendingRunId?:string;pendingStage?:string;runIds:string[];stop?:boolean};
export type CoverDoc={version:1;ownerNodeId:string;spec:CoverSpec;takes:CoverTake[];adoptedId:string;work?:CoverWork;stage:string;error:string};
export const coverKey=(id:string)=>'cover-v1:'+id;
export function defaultCoverSpec():CoverSpec{return {title:'',subtitle:'',template:'depth',mattingMethod:'birefnet',fusion:{protection:'pixels',lightDirection:'left',warmth:.025,exposure:-.06,grain:true,depth:true},synopsis:'',prompt:'',mode:'preserve',style:'cinema',aspect:'9:16',candidateType:'titles',count:3,photos:[],actors:[],referenceAssetId:'',seed:'',denoise:.55,repair:false,titleStyle:{font:'sans',effect:'cinema',layout:'bottom',size:1,x:.5,y:.81,lineHeight:1.12,tracking:3}};}
export function coverRoles(spec:CoverSpec){
 const groups=new Map<string,typeof spec.photos>();for(const p of spec.photos){const id=p.roleId||legacyRoleId(p.role);groups.set(id,[...(groups.get(id)??[]),p]);}
 const names=[...groups.keys()];
 return names.map((roleId,index)=>{const group=groups.get(roleId)!,role=group[0].role.trim();const pos=spec.template?COVER_TEMPLATES[spec.template].positions[index%3]:null;return {roleId,role,photo:group.find(p=>p.primary)??group[0],actor:spec.actors.find(a=>a.role===role)??{role,priority:index+1,x:names.length===1?.5:pos?.[0]??.25+.5*index/Math.max(1,names.length-1),y:pos?.[1]??1.04,scale:pos?.[2]??(names.length<3?1.04:.85),z:pos?.[3]??names.length-index}};}).sort((a,b)=>a.actor.priority-b.actor.priority);
}
export function validateCover(spec:CoverSpec){
 if(!spec.title.trim()||spec.title.length>120)throw Error('剧名需为1～120个字符，中文将按原文渲染');
 if(!spec.prompt.trim()&&!spec.director?.enabled)throw Error('请填写画面提示词');
 if(spec.director?.enabled){const d=spec.director,roles=coverRoles(spec);if(spec.mode!=='klein'||spec.aspect!=='9:16'||spec.candidateType!=='layouts')throw Error('导演层使用Klein、9:16、独立构图模式');if(roles.length>2)throw Error('双角色＋构图已占满3个参考槽；三人请关闭导演层使用旧Klein');if(!d.story.trim()||!d.conflict.trim())throw Error('请填写真实剧情及核心冲突');validatePosterPlans(d.plans,roles.map(r=>r.roleId));if(d.confirmed!==directorFingerprint(d,spec.photos))throw Error('请先设计并确认三方案；输入变化后须重新确认');if(d.selectedPlanIds?.some(id=>!d.plans.some(p=>p.id===id))||spec.count!==(d.selectedPlanIds?.length||3))throw Error('候选数量与选择的导演方案不匹配');}
 if(!COVER_SIZES[spec.aspect]||!COVER_STYLES[spec.style])throw Error('封面比例或风格无效');
 if(spec.template&&!COVER_TEMPLATES[spec.template])throw Error('构图模板无效');
 if(spec.mode==='klein'&&coverRoles(spec).length>3)throw Error('Klein实验只支持1～3人；尚未验收9人群像');
 if(spec.mode==='klein'&&spec.referenceAssetId)throw Error('Klein实验当前只提交人物独立参考；请清空背景风格参考，避免误以为已提交该图片');
 if(spec.photos.length<1||spec.photos.length>9)throw Error('人物剧照需为1～9张');
 if(spec.photos.some(p=>!p.assetId||!p.role.trim()))throw Error('每张剧照都需要指定角色分组');
 if(!Number.isInteger(spec.count)||spec.count<1||spec.count>5)throw Error('候选数量需为1～5');
 if(spec.seed.trim()&&(!Number.isSafeInteger(Number(spec.seed))||Number(spec.seed)<0||Number(spec.seed)+spec.count>Number.MAX_SAFE_INTEGER))throw Error('Seed需为非负安全整数');
 if(!Number.isFinite(spec.denoise)||spec.denoise<.1||spec.denoise>1)throw Error('重绘强度需为0.1～1');
 for(const role of coverRoles(spec))if(spec.photos.filter(p=>(p.roleId||legacyRoleId(p.role))===role.roleId&&p.primary).length>1)throw Error(role.role+'只能有一张主参考');
 return spec;
}
export function coverActors(spec:CoverSpec,index=0):CoverActor[]{
 return coverRoles(spec).map((role,roleIndex)=>{const actor={...role.actor};if(spec.candidateType==='layouts'&&index&&!spec.actors.some(a=>a.role===role.role)){actor.x=Math.max(.15,Math.min(.85,actor.x+(index%2?1:-1)*(roleIndex%2?-.07:.07)));actor.scale*=roleIndex===0?1.03:.92;actor.y+=roleIndex===0?0:-.06;}return actor;});
}
const STYLE_PROMPTS={cinema:'restrained charcoal and warm amber palette, cinematic low-key side light, atmospheric depth',romance:'warm ivory and muted rose palette, soft photographic key light, elegant urban atmosphere',thriller:'deep blue shadows and restrained red practical light, hard side light and suspenseful contrast',historical:'antique gold and ink-black palette, architectural depth, soft directional rim light'};
export function coverPrompt(spec:CoverSpec,index:number,background=false){
 const roles=coverRoles(spec).map(r=>`${r.role} (visual priority ${r.actor.priority})`).join(', ');
 const layout=spec.template?COVER_TEMPLATES[spec.template].scene:['clear central focal hierarchy','diagonal foreground/background hierarchy','balanced left/right dramatic relationship','primary figure foreground and secondary figures behind','layered ensemble with readable faces'][index%5];
 const count=coverRoles(spec).length;
 return `${background?'An unoccupied architectural background photograph. Empty foreground and background.':`A cinematic ${count}-person portrait, exactly ${count} adults total. The supplied composite defines each person's identity, clothing and position. ${roles}. The background is an empty scenic plate.`} ${spec.template?layout:STYLE_PROMPTS[spec.style]+'. '+layout}. Soft key from frame ${spec.fusion?.lightDirection??'left'}, neutral skin-compatible light and restrained warm practicals, no blown highlight behind faces. Photographic texture, grounded shadows, controlled detail hierarchy. Bottom quarter is calm readable negative space for a separately composited title. Artwork only, typography is added in a separate real-font layer. ${spec.synopsis?`Story context: ${spec.synopsis}. `:''}${spec.prompt}`;
}
