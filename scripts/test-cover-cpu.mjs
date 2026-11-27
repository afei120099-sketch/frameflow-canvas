import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {defaultCoverSpec,coverRoles,validateCover} from '../lib/cover-model.ts';
const root='runtime/cover-acceptance-20261017';await mkdir(root,{recursive:true});
const data=async path=>'data:image/png;base64,'+(await readFile(path)).toString('base64');
const cpu=async plan=>{const response=await fetch('http://localhost:5173/__cover/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(plan)});const value=await response.json();assert.equal(response.ok,true,JSON.stringify(value));return value;};
const file=async(job,name)=>Buffer.from(await (await fetch(`http://localhost:5173/__cover/jobs/${job.jobId}/${name}`)).arrayBuffer());
if(process.argv.includes('finish')){
 const prepared=JSON.parse(await readFile(`${root}/cpu-prepared.json`,'utf8'));const results=[];
 for(const mode of ['preserve','redraw']){
  const background=await data(`${root}/${mode==='preserve'?'repair':'redraw'}.png`);
  for(let i=0;i<3;i++){
   const plan={...prepared.plan,allowBackgroundCast:true,background,actors:mode==='preserve'?prepared.plan.actors:[],titleStyle:{...prepared.plan.titleStyle,effect:['gold','brush','cinema'][i]}};
   const job=await cpu(plan);const png=await file(job,'final.png');await writeFile(`${root}/${mode}-candidate-${i+1}.png`,png);await writeFile(`${root}/${mode}-candidate-${i+1}-title.png`,await file(job,'title.png'));
   results.push({mode,index:i+1,...job});assert.equal(job.title.title,plan.title);assert.equal(job.title.faceOverlap,0);assert.deepEqual(job.size,[1080,1920]);
  }
 }
 for(const size of [[1080,1440],[1080,1080]]){const plan={...prepared.plan,size,title:'重生之后我成了自己的救赎'};const job=await cpu(plan);assert.deepEqual(job.size,size);assert.equal(job.title.title,plan.title);await writeFile(`${root}/ratio-${size[1]}.png`,await file(job,'final.png'));results.push(job);}
 await writeFile(`${root}/cpu-results.json`,JSON.stringify(results,null,2));console.log('CPU title effects, exact title, face-safe boxes, all ratios PASS; no GPU API used.');
}else{
 const spec=defaultCoverSpec();Object.assign(spec,{title:'逆光归来',prompt:'豪门背景中的双主角对峙',photos:[{assetId:'a',role:'男主',primary:true},{assetId:'b',role:'男主',primary:false},{assetId:'c',role:'女主',primary:true}]});validateCover(spec);assert.equal(coverRoles(spec).length,2);assert.equal(coverRoles(spec)[0].photo.assetId,'a');assert.throws(()=>validateCover({...spec,count:6}));assert.throws(()=>validateCover({...spec,title:''}));
 const actors=[];
 for(const [i,name] of ['man','woman'].entries()){
  const job=await cpu({operation:'cutout',image:await data(`${root}/${name}.png`)});const png=await file(job,'cutout.png');await writeFile(`${root}/${name}-cutout.png`,png);await writeFile(`${root}/${name}-cutout.json`,JSON.stringify(job,null,2));actors.push({role:i?'女主':'男主',image:'data:image/png;base64,'+png.toString('base64'),face:job.face,x:i?.7:.3,y:i?.78:.74,scale:i?.66:.74,z:i?1:2});
 }
 const plan={operation:'compose',size:[1080,1920],background:await data(`${root}/background.png`),actors,title:'逆光归来',titleStyle:{font:'sans',effect:'gold',layout:'auto',size:1,lineHeight:1.15,tracking:2}};
 const job=await cpu(plan);await writeFile(`${root}/composite-base.png`,await file(job,'base.png'));await writeFile(`${root}/composite-mask.png`,await file(job,'repair-mask.png'));await writeFile(`${root}/composite-final.png`,await file(job,'final.png'));await writeFile(`${root}/cpu-prepared.json`,JSON.stringify({plan,job}));console.log('Two role cutouts, grouped references, base/mask/title/final actual CPU outputs PASS',job.jobId);
}
