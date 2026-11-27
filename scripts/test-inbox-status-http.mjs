import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {startInboxServer} from './inbox-server.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'frameflow-inbox-cpu-'));
const project='isolated',dir=path.join(root,project);await fs.mkdir(dir);
const source='{"version":"shot-queue-v1","validateOnly":true}',hash=createHash('sha256').update(source).digest('hex');
await fs.writeFile(path.join(dir,'check_validate.json'),source);
const server=await startInboxServer({port:0,root});
try{
  const base='http://127.0.0.1:'+server.address().port+'/?';
  const list=await(await fetch(base+new URLSearchParams({op:'list',project}))).json();assert.equal(list.files[0].kind,'queue');
  const write=value=>fetch(base+new URLSearchParams({op:'write',project,name:'check_validate_status.json'}),{method:'POST',body:JSON.stringify(value)});
  const latest={queue:'check_validate.json',contentHash:hash,state:'validated',updatedAt:'2026-10-21T10:00:00Z'};
  assert.equal((await write(latest)).status,200);
  assert.equal((await write({...latest,state:'rejected',updatedAt:'2026-10-21T09:00:00Z'})).status,409);
  assert.equal((await write({...latest,contentHash:'old-hash'})).status,409);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'check_validate_status.json'),'utf8')).state,'validated');
  console.log('PASS real isolated loopback HTTP: _validate discovery, atomic JSON write, old-content and old-timestamp refusal; no production endpoint or GPU used. Temp evidence: '+root);
}finally{await new Promise(resolve=>server.close(resolve));}
