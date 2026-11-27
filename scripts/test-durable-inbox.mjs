import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {durableJson,byteHash} from './durable-json.mjs';
import {startInboxServer} from './inbox-server.mjs';
const root=path.resolve('runtime/tail-pipeline-20261025/receipt-repair/test-'+Date.now());await fs.mkdir(root,{recursive:true});
const project='isolated',dir=path.join(root,project);await fs.mkdir(dir);
const file=path.join(dir,'_inbox_state.json'),base={images:{},queues:{old:{file:'old_queue.json',result:'stopped',requestId:'preserve',userHeld:true}}};
await durableJson(file,base,{backup:true,requireValidCurrent:true});
await Promise.all(Array.from({length:12},(_,i)=>durableJson(file,{...base,revision:i},{backup:true,requireValidCurrent:true})));
assert.equal(JSON.parse(await fs.readFile(file,'utf8')).revision,11);
assert.equal(JSON.parse(await fs.readFile(path.join(dir,'.frameflow-state-backups/_inbox_state.json/previous-good.json'),'utf8')).revision,10);
const before=await fs.readFile(file);await assert.rejects(()=>durableJson(file,Buffer.alloc(512),{backup:true}),/JSON/);assert.ok((await fs.readFile(file)).equals(before));
const rename=fs.rename;fs.rename=async(a,b)=>{if(b===file)throw Error('isolated power-loss-before-rename');return rename(a,b);};
try{await assert.rejects(()=>durableJson(file,{...base,revision:99},{backup:true}),/isolated power-loss/);}finally{fs.rename=rename;}
assert.ok((await fs.readFile(file)).equals(before),'failed replacement must preserve original');
const backupName='_inbox_state.json.bak_test',backup=Buffer.from(JSON.stringify(base)),corrupt=Buffer.alloc(733);
await fs.writeFile(path.join(dir,backupName),backup);await fs.writeFile(file,corrupt);
await fs.writeFile(path.join(dir,'old_queue.json'),JSON.stringify({version:'shot-queue-v1'}));
await fs.writeFile(path.join(dir,'_inbox_control.json'),JSON.stringify({paused:false,heldQueueHashes:['preexisting'],keep:'original'}));
const server=await startInboxServer({root,port:0}),origin='http://127.0.0.1:'+server.address().port;
const post=(op,value)=>fetch(origin+'/?'+new URLSearchParams({op,project,name:'_inbox_state.json'}),{method:'POST',body:JSON.stringify(value)});
try{
 const denied=await post('write',{images:{},queues:{}});assert.equal(denied.status,409);assert.ok((await fs.readFile(file)).equals(corrupt),'cannot reset corrupt record');
 const bad=await post('restore-state',{backupName,expectedBackupSha256:'f'.repeat(64),expectedCorruptSha256:byteHash(corrupt)});assert.equal(bad.status,409);
 const restored=await post('restore-state',{backupName,expectedBackupSha256:byteHash(backup),expectedCorruptSha256:byteHash(corrupt)});assert.equal(restored.status,200);assert.equal((await restored.json()).state,'restored_held');
 assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),base);
 const control=JSON.parse(await fs.readFile(path.join(dir,'_inbox_control.json'),'utf8'));assert.equal(control.paused,true);assert.equal(control.keep,'original');assert.ok(control.heldQueueHashes.includes('preexisting'));assert.equal(control.heldQueueHashes.length,2);
 assert.ok((await fs.readFile(path.join(dir,'.frameflow-state-backups/_inbox_state.json/corrupt-'+byteHash(corrupt)+'.bin'))).equals(corrupt));
 const again=await post('restore-state',{backupName,expectedBackupSha256:byteHash(backup),expectedCorruptSha256:byteHash(corrupt)});assert.equal(again.status,409,'cannot replay stale restore');
 console.log('PASS durable JSON: serialized real disk writes, two valid backups, zero/truncated rejection, failed rename keeps original, corrupt-state reset refusal, hash-scoped restore, all old queue hashes held, corrupt bytes retained. No GPU.');
}finally{await new Promise(resolve=>server.close(resolve));server.closeAllConnections();}
