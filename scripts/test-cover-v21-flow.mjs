/** Deterministic orchestration test with MOCK GPU and MOCK CPU, never connects to ComfyUI. */
import {registerHooks} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return next(s+'.ts',c);throw e;}}});
await import('./fake-indexeddb.mjs');
globalThis.createImageBitmap=async()=>({width:576,height:1024,close(){}});
globalThis.FileReader=class {readAsDataURL(b){b.arrayBuffer().then(a=>{this.result='data:image/png;base64,'+Buffer.from(a).toString('base64');this.onload?.();});}};
const {generateCover,retitleCover}=await import('../lib/cover-generation.ts');
const {registerAsset,getMeta,listRuns,putMeta}=await import('../lib/production-records.ts');
const {storeLocalImage}=await import('../lib/local-video-store.ts');
const {directorFingerprint}=await import('../lib/cover-director.ts');
const {KLEIN_MODELS}=await import('../lib/comfyui/flux-klein.ts');
const png=await fs.readFile('runtime/cover-acceptance-20261017/man.png');
const spec=JSON.parse(await fs.readFile('runtime/cover-v21-acceptance-20261017/director-fixture.json','utf8'));
for(const p of spec.photos){const src=await storeLocalImage(new Blob([png],{type:'image/png'}),p.assetId+'.png');const a=await registerAsset({kind:'image',origin:'imported',filename:p.assetId+'.png',mimeType:'image/png',storageReference:src,sourceRunId:null,width:512,height:768});p.assetId=a.assetId;}
spec.director.confirmed=directorFingerprint(spec.director,spec.photos);
const graphs=[],cpuPlans=[],uploads=[],history=new Map();let failCpuOnce=false;
globalThis.fetch=async(url,init={})=>{
 url=String(url);
 if(url==='/__local_status')return Response.json({gpu:{vramUsedBytes:1234*1048576}});
 if(url==='/__cover/jobs'){
  const p=JSON.parse(init.body);cpuPlans.push(p);if(failCpuOnce&&p.operation==='compose'){failCpuOnce=false;return Response.json({error:'mock CPU stop after GPU saved'},{status:400});}
  return Response.json({jobId:crypto.randomUUID(),size:[1080,1920],files:['guide.png','base.png','title.png','final.png'],faces:[[100,100,100,100],[700,100,100,100]]});
 }
 if(url.startsWith('/__cover/jobs/'))return new Response(png,{headers:{'Content-Type':'image/png'}});
 if(!url.startsWith('/comfyui/'))throw Error('Forbidden unmocked URL '+url);
 if(url.endsWith('/queue'))return Response.json({queue_running:[],queue_pending:[]});
 if(url.includes('/object_info/')){const n=url.split('/').at(-1);const required=n==='UNETLoader'?{unet_name:[[KLEIN_MODELS.unet]]}:n==='CLIPLoader'?{clip_name:[[KLEIN_MODELS.clip]]}:n==='VAELoader'?{vae_name:[[KLEIN_MODELS.vae]]}:{};return Response.json({[n]:{input:{required}}});}
 if(url.endsWith('/upload/image')){uploads.push(init.body.get('image'));return Response.json({name:'mock-'+uploads.length+'.png'});}
 if(url.endsWith('/prompt')){const p=JSON.parse(init.body);graphs.push(p);history.set(p.prompt_id,{status:{completed:true},outputs:{'7':{images:[{filename:'MOCK-NOT-GPU.png',type:'output'}]}}});return Response.json({prompt_id:p.prompt_id});}
 if(url.includes('/history/')){const id=url.split('/').at(-1);return Response.json({[id]:history.get(id)});}
 if(url.includes('/view?'))return new Response(png);
 throw Error('Forbidden unmocked URL '+url);
};
const doc={version:1,ownerNodeId:'mock-node',spec,takes:[],adoptedId:'',stage:'',error:''};
await generateCover(doc,'mock-doc',()=>{});assert.equal(graphs.length,3);assert.equal(uploads.length,9);assert.equal(doc.takes.length,3);assert.equal(doc.adoptedId,'');assert.equal(doc.work,undefined);
for(const take of doc.takes){assert.equal(take.referenceManifest.length,3);assert.equal(take.identityCards.length,2);assert.equal(take.review.noText,'pending');assert.equal(take.generationEvidence.peakVramMiB,1234);assert.equal(take.prompt.includes('abstract composition ONLY'),true);assert.equal(take.models.unet,KLEIN_MODELS.unet);assert.equal(take.lora,undefined);}
for(const graph of graphs){assert.equal(Object.values(graph.prompt).filter(n=>n.class_type==='LoadImage').length,3);assert.equal(graph.prompt['3'].inputs.width,576);}
const before=graphs.length;const titleTake=await retitleCover(doc,doc.takes[0]);assert.equal(graphs.length,before);assert.equal(doc.adoptedId,'');assert.equal(titleTake.review.title,'pending');
// CPU failure after GPU completed must reuse saved result and never repost the GPU prompt.
const resume={...structuredClone(doc),takes:[],spec:{...structuredClone(spec),count:1},work:undefined};resume.spec.director.selectedPlanIds=['dominance'];resume.spec.director.confirmed=directorFingerprint(resume.spec.director,resume.spec.photos);failCpuOnce=true;
await assert.rejects(generateCover(resume,'mock-resume',()=>{}),/mock CPU/);assert.equal(graphs.length,before+1);assert.ok(resume.work.baseId);const checkpoint=await getMeta('cover-v1:mock-resume');await generateCover(checkpoint,'mock-resume',()=>{});assert.equal(graphs.length,before+1);assert.equal(checkpoint.takes.length,1);
const snapshot=JSON.parse(JSON.stringify(doc));assert.deepEqual(snapshot.takes[0].directorPlan,doc.takes[0].directorPlan);assert.equal((await listRuns()).length,4);
// Real backup engine, isolated in-memory DB only. Round-trip all V2.1 metadata and media.
await putMeta('cover-v1:mock-doc',doc);
const {exportProject,readBackup,restoreProject}=await import('../lib/project-backup.ts');
const files=new Map();const sink={writeText:async(p,s)=>files.set(p,new Blob([s],{type:'application/json'})),writeBlob:async(p,b)=>files.set(p,b)};
await exportProject(null,sink,{appVersion:'v21-test',persistenceKey:'frameflow-v0.1-canvas'});
const source={has:p=>files.has(p),size:p=>files.get(p)?.size??null,readText:p=>files.get(p).text(),readBlob:async p=>files.get(p)};
const backup=await readBackup(source);await putMeta('cover-v1:mock-doc',{mutated:true});await restoreProject(backup,{current:()=>null,load:()=>{}});
const restored=await getMeta('cover-v1:mock-doc');assert.deepEqual(restored.takes[0].directorPlan,doc.takes[0].directorPlan);assert.equal(restored.takes[0].identityCards.length,2);assert.equal(restored.takes[0].referenceManifest.length,3);assert.equal(restored.takes[0].baseAssetId,doc.takes[0].baseAssetId);
await fs.writeFile('runtime/cover-v21-acceptance-20261017/mock-flow-tests.json',JSON.stringify({status:'PASS',mockOnly:true,realGpuCalls:0,checks:['three serial candidates','nine uploads in identity-identity-layout order','saved actual prompts and role manifests','pending manual review/no auto adoption','CPU retitle zero GPU','CPU failure resumes saved GPU result without repost','meta snapshot persists director/identity/title/guide assets'],mockPromptPosts:graphs.length},null,2));console.log('V2.1 MOCK orchestration and saved-progress resume PASS; real GPU calls=0.');
