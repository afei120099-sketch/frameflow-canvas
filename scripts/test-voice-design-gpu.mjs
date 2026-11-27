// Explicit real GPU acceptance: two fictional adult voices, 3 auditions + 1 contrast voice.
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {runVoiceDesign} from '../lib/voice-design.ts';
const origin=process.argv[2]??'http://127.0.0.1:5173';
const output=new URL('../runtime/voice-design-acceptance-20261018/',import.meta.url);await mkdir(output,{recursive:true});
const records=[];
for(const [name,description,count] of [
 ['female','成年女性，25岁左右，清澈温柔的中音，普通话。像和熟悉的人面对面说话，自然有呼吸与停顿，轻轻安慰对方，不要播音腔。',3],
 ['male','成年男性，40岁左右，低沉厚实但不沙哑的中低音，普通话。说话沉稳从容，像面对面聊天，自然有停顿，不要播音腔。',1]
]){
 const text='别担心，先把事情慢慢说清楚。我会认真听，也会陪你一起想办法。';
 const started=Date.now();console.log('Starting',name);
 const results=await runVoiceDesign({text,description,count,seed:424211},{fetch:(url,init)=>fetch(origin+url,init),onStage:stage=>console.log(name,stage),onPending:jobId=>{console.log('Job ID',jobId);records.push({name,id:jobId,description,count,text,startedAt:new Date().toISOString()});}});
 assert.equal(results.length,count);
 for(let i=0;i<results.length;i++){
  const bytes=Buffer.from(await results[i].blob.arrayBuffer());assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.ok(bytes.length>10000);
  await writeFile(new URL(`${name}-${i+1}.wav`,output),bytes);
 }
 records.at(-1).elapsedMs=Date.now()-started;records.at(-1).outputs=results.map(r=>({filename:r.filename,seed:r.seed,bytes:r.blob.size}));
 await writeFile(new URL('gpu-results.json',output),JSON.stringify({records,visualAndListeningReview:'PENDING_USER_LISTENING',noProductionDefaultsChanged:true},null,2));
 console.log('PASS actual AI audio',name,Date.now()-started,'ms');
}
console.log('PASS real Qwen VoiceDesign: 3 candidate WAVs and one adult male contrast WAV. User listening review still required.');
