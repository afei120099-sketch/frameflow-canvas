import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [entry,executablePath,baseUrl='http://127.0.0.1:5173/']=process.argv.slice(2);
const {chromium}=await import(pathToFileURL(entry).href),browser=await chromium.launch({executablePath,headless:true});
try{
 const context=await browser.newContext(),page=await context.newPage();
 await context.route('**/__automation/**',r=>r.fulfill({status:503,body:'isolated'}));
 await context.route('**/pending-shot-queue.json',r=>r.fulfill({status:404,body:''}));
 await page.goto(baseUrl);
 const result=await page.evaluate(async()=>{
  const url='/__comfy_progress';
  return new Promise(resolve=>{
   const socket=new EventSource(`${url}?clientId=${crypto.randomUUID()}`);let status=false,done=false;
   const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);socket.close();resolve({url,status,error});};
   const timer=setTimeout(()=>finish('timeout'),8000);
   socket.onmessage=e=>{if(typeof e.data==='string'&&JSON.parse(e.data).type==='status'){status=true;setTimeout(()=>finish(socket.readyState===EventSource.OPEN?null:'closed after status'),1000);}};
   socket.onerror=()=>finish('connection error');
  });
 });
 assert.equal(result.error,null);assert.equal(result.status,true);assert.ok(result.url.includes('/__comfy_progress'));
 console.log('PASS same-origin SSE relay: initial ComfyUI status received and connection stayed open; no GPU task submitted.',result);
}finally{await browser.close();}
