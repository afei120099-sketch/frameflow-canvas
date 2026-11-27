import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {readTailHD} from '../lib/tail-frame-hd-job.ts';
const code=ts.transpileModule(readFileSync('components/canvas/tail-frame-hd-inline.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
let complete,calls=0,submitted;
const module={exports:{}};
vm.runInNewContext(code,{exports:module.exports,require:name=>{
  if(name.includes('tail-frame-hd-job'))return {readTailHD,enhanceTailPNG:async(id,stage,reserved,allow)=>{calls++;submitted=allow;stage('testing');await reserved('original-prompt');return new Promise(resolve=>complete=resolve);}};
  if(name.includes('canvas-events'))return {showCanvasToast:()=>{}};
  return {};
},Map,Promise});
const {runTailFrameHD}=module.exports;
function fixture(){let node={id:'shape:test',type:'h3-node',props:{prompt:'preserve',videoFirstFrame:{src:'image:original',name:'original.png',sourceNodeId:'shape:source'}},meta:{tailFrameHD:{originalAssetId:'original',expectedSrc:'image:original',status:'pending',stage:'pending'}}};return {get:()=>node,editor:{getShape:()=>node,updateShape:patch=>{node={...node,...patch,props:{...node.props,...patch.props}};}}};}
async function pending(){for(let n=0;n<5;n++)await Promise.resolve();}
const enhanced={assetId:'hd',storageReference:'image:hd',filename:'hd.png'};
let f=fixture(),work=runTailFrameHD(f.editor,'shape:test',true);
assert.equal(runTailFrameHD(f.editor,'shape:test',true),work,'duplicate clicks reuse running job');
await pending();complete(enhanced);await work;
assert.equal(calls,1);assert.equal(submitted,true);assert.equal(f.get().props.videoFirstFrame.src,'image:hd');assert.equal(f.get().props.prompt,'preserve');assert.equal(f.get().meta.tailFrameHD.status,'completed');
f=fixture();work=runTailFrameHD(f.editor,'shape:test');await pending();
f.editor.updateShape({props:{videoFirstFrame:{src:'image:user-change'}}});complete(enhanced);await work;
assert.equal(submitted,false,'recovery queries only');assert.equal(f.get().props.videoFirstFrame.src,'image:user-change');assert.equal(f.get().meta.tailFrameHD.status,'detached');
f=fixture();work=runTailFrameHD(f.editor,'shape:test');await pending();
f.editor.updateShape({meta:{tailFrameHD:{...f.get().meta.tailFrameHD,status:'detached'}}});complete(enhanced);await work;
assert.equal(f.get().props.videoFirstFrame.src,'image:original','opt-out prevents late replacement');
console.log('PASS actual inline controller with CPU stubs: duplicate clicks one job, same-node HD update, prompt retained, recovery query-only, manual edits and original-frame opt-out respected.');
