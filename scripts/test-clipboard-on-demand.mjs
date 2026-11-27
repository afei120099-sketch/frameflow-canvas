import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { clipboardPlugin } from './clipboard-vite-plugin.mjs';

let handler, starts=0, forwards=0;
clipboardPlugin({ensure:async()=>{starts++;await new Promise(resolve=>setTimeout(resolve,40));},forward:async(url,options)=>{
  forwards++; assert.equal(url,'http://127.0.0.1:5193/image');assert.equal(options.method,'POST');
  return new Response(null,{status:204});
}}).configureServer({middlewares:{use(fn){handler=fn;}}});
const server=createServer((req,res)=>handler(req,res,()=>{res.writeHead(404);res.end();}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const send=(headers={},method='POST',body='png')=>fetch(`${base}/__clipboard/image`,{method,headers:{origin:base,'content-type':'image/png',...headers},...(method==='POST'?{body}:{})});
try {
  assert.equal((await send({origin:'https://evil.example'})).status,403);
  assert.equal((await send({},'GET')).status,405);
  assert.equal((await send({'content-type':'text/plain'})).status,415);
  assert.equal(starts,0,'invalid requests never start native helper');
  assert.deepEqual((await Promise.all([send(),send()])).map(r=>r.status),[204,204]);
  assert.equal(starts,1,'concurrent requests share helper startup');assert.equal(forwards,2);
  assert.equal((await send()).status,204);assert.equal(starts,2,'later requests recheck/recover helper automatically');
  assert.equal((await fetch(`${base}/other`)).status,404);
  console.log('PASS clipboard on-demand: local-origin guard, fixed destination, shared startup, repeated health recovery, no queue/media access.');
} finally { await new Promise(resolve=>server.close(resolve)); }
