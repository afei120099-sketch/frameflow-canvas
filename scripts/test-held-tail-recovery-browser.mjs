import assert from 'node:assert/strict';
import http from 'node:http';
import {browserModuleBundle} from './browser-module-bundle.mjs';
import {pathToFileURL} from 'node:url';
// Playwright entry and browser come from FRAMEFLOW_PLAYWRIGHT_ENTRY (path to playwright/index.mjs) and FRAMEFLOW_CHROME_PATH.
const {chromium}=await import(process.env.FRAMEFLOW_PLAYWRIGHT_ENTRY?pathToFileURL(process.env.FRAMEFLOW_PLAYWRIGHT_ENTRY).href:'playwright');
const bundle=browserModuleBundle(['production-records','local-video-store','canvas-library-scope','held-tail-recovery','held-image-integrity']);
const fixture={paused:true,inQueue:false,inHistory:false,posts:0};
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://test');
 if(req.method==='POST'){fixture.posts++;res.writeHead(405);res.end();return;}
 if(u.pathname==='/'){res.end('<title>Isolated held-tail repair test</title>');return;}
 if(u.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript; charset=utf-8');res.end(bundle);return;}
 let data={};
 if(u.pathname==='/__inbox/control')data={stop:false,stopSessions:[],pauseSessions:fixture.paused?['session']:[],effective:{submit:true,autoEnqueue:true,autoChain:true}};
 else if(u.pathname==='/comfyui/queue')data={queue_running:fixture.inQueue?[[1,'held-prompt']]:[],queue_pending:[]};
 else if(u.pathname.startsWith('/comfyui/history/'))data=fixture.inHistory?{'held-prompt':{status:{completed:true}}}:{};
 else if(u.pathname==='/comfyui/view'){res.setHeader('content-type','image/png');res.end(Buffer.alloc(123));return;}
 else {res.writeHead(404);res.end();return;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.FRAMEFLOW_CHROME_PATH||undefined,headless:true});
const context=await browser.newContext();await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
const page=await context.newPage();
try{
 await page.goto(origin);await page.addScriptTag({url:origin+'/bundle.js'});
 await page.evaluate(async()=>{
  const m=window.testModules,r=m['production-records'];m['canvas-library-scope'].configureCanvasLibraryScope(()=>({pageId:'test',references:new Set()}));
  const run=await r.createRun({capabilityId:'h3_fl2va',ownerNodeId:'node',parameters:{},inputAssetIds:[],rawPrompt:'test',finalPrompt:'test',seed:1});
  await r.updateRun(run.runId,{comfyPromptId:'held-prompt',status:'queued',submission:'accepted'});
  const src=await m['local-video-store'].storeLocalImage(new Blob([new Uint8Array(123)],{type:'image/png'}),'bad.png');
  window.target={sessionId:'session',nodeId:'node',edge:'first',oldSrc:src,recognizedOutputSha256:'a'.repeat(64)};
  window.job={sessionId:'session',promptId:'held-prompt',number:1,state:'held',reason:'pause',deleteConfirmed:true,graph:{image:{class_type:'LoadImage',inputs:{image:'bad.png'}},c:{class_type:'MiniMaxH3AudioConditioningT8',inputs:{first_frame:['image',0]}}},extraData:{}};
  await r.putMeta('inbox-file-held-comfy',[window.job]);
 });
 const attempt=()=>page.evaluate(async()=>{try{return await window.testModules['held-tail-recovery'].retireInvalidHeldTail(window.target);}catch(error){return{error:String(error)};}});
 fixture.paused=false;assert.match((await attempt()).error,/暂停/);fixture.paused=true;
 fixture.inQueue=true;assert.match((await attempt()).error,/队列或历史/);fixture.inQueue=false;
 fixture.inHistory=true;assert.match((await attempt()).error,/队列或历史/);fixture.inHistory=false;
 await page.evaluate(async()=>{await window.testModules['production-records'].putMeta('inbox-file-held-comfy',[{...window.job,deleteConfirmed:false}]);});
 assert.match((await attempt()).error,/凭证/);
 await page.evaluate(async()=>{await window.testModules['production-records'].putMeta('inbox-file-held-comfy',[window.job]);});
 const proof=await attempt();assert.equal(proof.deleteConfirmed,true);assert.equal(proof.promptId,'held-prompt');
 assert.deepEqual(await attempt(),proof,'same retirement is idempotent');
 const readback=await page.evaluate(async()=>{const m=window.testModules,j=(await m['production-records'].getMeta('inbox-file-held-comfy'))[0];return{state:j.state,graphUnchanged:JSON.stringify(j.graph)===JSON.stringify(window.job.graph),allowed:await m['held-tail-recovery'].retiredHeldAllows('session','node','held-prompt'),wrongNode:await m['held-tail-recovery'].retiredHeldAllows('session','other','held-prompt')};});
 assert.deepEqual(readback,{state:'abandoned',graphUnchanged:true,allowed:true,wrongNode:false});
 assert.equal(fixture.posts,0,'recognition must never submit GPU');
 await page.evaluate(async()=>{const m=window.testModules;let read=0;try{await m['held-image-integrity'].assertHeldGraphImages(window.job.graph,undefined,async()=>{read++;throw Error('all-zero input');});throw Error('bad graph accepted');}catch(error){if(!String(error).includes('all-zero'))throw error;}if(read!==1)throw Error('graph was not checked');});
 console.log('PASS native browser/IDB: pause required, no retirement of running/history/unconfirmed jobs, exact zero input comparison, original graph retained, idempotent receipt, wrong-node refusal, held-image preflight, zero GPU POST.');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
