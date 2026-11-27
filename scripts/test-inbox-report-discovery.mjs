import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startInboxServer} from './inbox-server.mjs';
import {publishInboxArtifacts} from './inbox-artifacts.mjs';

// Only a temporary runtime inbox and an ephemeral loopback port; no GPU or IDB.
const root=path.resolve('runtime/inbox-report-scan-fix-20261026/test-'+Date.now());
const project='isolated',dir=path.join(root,project);
await fs.mkdir(dir,{recursive:true});
const fixtures={
  '正常_queue.json':'queue', '正常_validate.json':'queue',
  '_user_queue.json':'queue', 'my_compiled_test_queue.json':'queue',
  'UPPER_VALIDATE.JSON':'queue', '_compiled_正常_queue.json':'report',
  '_compiled_正常_validate.json':'report',
  '_compiled__compiled_正常_validate.json':'report',
  '_COMPILED_UPPER_VALIDATE.JSON':'report',
  '_compiled_正常_validate_status.json':'report',
  '正常_queue_status.json':'status','_inbox_state.json':'state',
  'assets_map.json':'map','正常_queue.json.bak':'other',
  '正常_queue.json.tmp':'other','_compiled_reference.png':'image',
};
for(const name of Object.keys(fixtures))await fs.writeFile(path.join(dir,name),JSON.stringify({fixture:name}));
const before=new Map(await Promise.all(Object.keys(fixtures).map(async name=>[name,await fs.readFile(path.join(dir,name))])));
const server=await startInboxServer({root,port:0});
const origin='http://127.0.0.1:'+server.address().port;
const request=async(op,name)=>{const r=await fetch(origin+'/?'+new URLSearchParams({op,project,...(name?{name}:{})}));assert.equal(r.status,200);return r.json();};
try{
  for(let scan=0;scan<4;scan++){
    const {files}=await request('list');
    for(const [name,expected]of Object.entries(fixtures)){
      const f=files.find(x=>x.name===name);assert.equal(f?.kind,expected,name);
      assert.equal(typeof f.sha256,expected==='queue'||expected==='image'?'string':'undefined',name);
    }
    // Use the real report writer, then the real HTTP scanner. Even a failed
    // validation report must stay output rather than recursively validating.
    await publishInboxArtifacts(root,{project,source:'正常_validate.json',validation:{ok:false,errors:['fixture only'],compiledShots:[],gpuSubmitted:false}});
    const next=(await request('list')).files;
    assert.equal(next.find(f=>f.name==='_compiled_正常_validate.json').kind,'report');
    assert.equal(next.filter(f=>f.kind==='queue').length,5);
    assert.equal(next.filter(f=>f.name.startsWith('_compiled_')).length,5);
  }
  assert.equal((await request('file','_compiled_正常_validate.json')).gpuSubmitted,false);
  for(const [name,bytes]of before){
    if(name==='_compiled_正常_validate.json')continue; // the writer's intended output
    assert.ok((await fs.readFile(path.join(dir,name))).equals(bytes),name+' must be retained');
  }
  const state={images:{keep:{assetId:'original',placedOn:['page:original']}},queues:{old:{result:'stopped',userHeld:true}}};
  const write=await fetch(origin+'/?'+new URLSearchParams({op:'write',project,name:'_inbox_state.json'}),{method:'POST',body:JSON.stringify(state)});
  assert.equal(write.status,200);assert.deepEqual(await request('file','_inbox_state.json'),state);
  const evidence={passed:true,root,scans:4,fixtures,sourceQueueCount:5,gpuSubmitted:false,originalFilesRetained:true,compiledHash:createHash('sha256').update(await fs.readFile(path.join(dir,'_compiled_正常_validate.json'))).digest('hex')};
  await fs.writeFile(path.resolve('runtime/inbox-report-scan-fix-20261026/cpu-acceptance.json'),JSON.stringify(evidence,null,2));
  console.log('PASS: real report writer + HTTP discovery, repeated scans, nested/case-insensitive reports excluded; real queues, validation, images, reads and durable state writes retained. No GPU.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
