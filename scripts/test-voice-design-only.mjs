import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const source=fs.readFileSync('components/canvas/tts-node.tsx','utf8');
const patches=[],calls=[];
let posts=0,queries=0,legacyQueries=0;
const react={...React,useState:initial=>[initial,()=>{}],useEffect(){},useRef:initial=>({current:initial})};
const validator=new Proxy(()=>validator,{get:()=>validator});
const exports={};
const result={blob:new Blob(['audio'],{type:'audio/wav'}),filename:'new.wav',promptId:'original-design',seed:42,voiceDescription:'自然女声'};
const js=ts.transpileModule(source+'\nexport {TTSContent};',{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}});
assert.deepEqual(js.diagnostics,[]);
vm.runInNewContext(js.outputText,{
  exports,React:react,Blob,crypto,AbortController,URL,setTimeout,clearTimeout,Path2D:class{},
  Audio:class {duration=1;set src(value){if(value)queueMicrotask(()=>this.onloadedmetadata());} removeAttribute(){} load(){}},
  require(name){
    if(name==='react')return react;
    if(name==='tldraw')return {BaseBoxShapeUtil:class{},HTMLContainer:'div',T:validator,useValue:()=>true,createShapeId:()=>`shape:${calls.length}`};
    if(name==='lucide-react')return {Mic2:()=>null,Sparkles:()=>null,X:()=>null};
    if(name==='./media-hooks')return {useAcquiredMediaUrl:src=>src};
    if(name==='@/lib/node-task-activity')return {holdNodeTask:()=>()=>{}};
    if(name==='@/lib/voice-design')return {runVoiceDesign:async(input,opts)=>{posts++;opts.onPending('original-design');assert.equal(input.text,'你好');return [result];},waitForVoiceDesign:async(id)=>{queries++;assert.equal(id,'original-design');return [result];}};
    if(name==='@/lib/comfyui/cosyvoice')return {waitForCosyVoice:async(id)=>{legacyQueries++;assert.equal(id,'legacy-prompt');return result;}};
    if(name==='@/lib/local-video-store')return {storeLocalAudio:async()=> 'media:new'};
    if(name==='@/lib/production-records')return {registerAsset:async()=>({assetId:'asset:new'})};
    return {};
  },
});
const defaults=new exports.TTSNodeUtil().getDefaultProps();
assert.equal(defaults.voiceMode,'design');
let shape;
const editor={getCurrentPageId:()=> 'page:isolated-test',getShape:()=>shape,getCurrentPageShapes:()=>[],updateShape:update=>{patches.push(update.props);shape={...shape,props:{...shape.props,...update.props}};},createShape:node=>calls.push(node)};
const walk=(node,predicate)=>{
  if(!node||typeof node!=='object')return [];
  if(Array.isArray(node))return node.flatMap(child=>walk(child,predicate));
  return [...(predicate(node)?[node]:[]),...walk(node.props?.children,predicate)];
};
const byClass=(tree,value)=>walk(tree,node=>node.props?.className===value)[0];
const render=(props={})=>{
  shape={id:'shape:test',type:'tts-node',x:0,y:0,props:{...defaults,voiceDescription:'自然女声',auditionText:'你好',...props}};
  return exports.TTSContent({shape,editor});
};
for(const voiceMode of ['design','reference','preset',undefined]){
  const tree=render({voiceMode});
  assert.equal(walk(tree,node=>node.props?.['aria-label']==='配音参考音色').length,0);
  assert.ok(byClass(tree,'tts-controls'));
  assert.equal(walk(byClass(tree,'tts-controls'),node=>node.props?.className==='ff-primary tts-generate').length,0);
  assert.equal(walk(byClass(tree,'tts-footer'),node=>node.props?.className==='ff-primary tts-generate').length,1);
  assert.ok(walk(tree,node=>node.props?.['aria-label']==='角色音色描述').length);
}
const oldTake={src:'media:old',assetId:'asset:old',name:'old.wav',duration:2,promptId:'old',text:'旧台词',seed:1};
let tree=render({voiceMode:'reference',src:oldTake.src,takes:[oldTake]});
assert.equal(shape.props.takes[0],oldTake);
assert.equal(posts,0,'render must not submit');
await byClass(tree,'ff-primary tts-generate').props.onClick();
// UI handler intentionally returns void; let asynchronous audio persistence finish.
await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(posts,1);assert.equal(shape.props.takes[0],oldTake);assert.equal(shape.props.takes.length,2);
assert.equal(calls.length,1,'only a new audio output is placed');
tree=render({pendingDesignId:'original-design',lastSeed:42});
byClass(tree,'ff-primary tts-generate').props.onClick();await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(queries,1);assert.equal(posts,1,'recover without duplicate submission');
tree=render({pendingId:'legacy-prompt'});
byClass(tree,'ff-primary tts-generate').props.onClick();await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(legacyQueries,1);assert.equal(posts,1,'retired engine can only read an accepted task');
assert.ok(!source.includes("voiceMode:'reference'"),'saving a role must not return to removed mode');
assert.ok(!source.includes('runCosyVoice')&&!source.includes('runPresetTts'));

if(process.argv[2]){
  const {pathToFileURL}=await import('node:url');
  const {chromium}=await import(pathToFileURL(process.argv[2]).href);
  const browser=await chromium.launch({executablePath:process.argv[3],headless:true});
  try{
    const page=await browser.newPage({viewport:{width:900,height:900}});
    for(const h of [650,500]){
      tree=render({h,src:oldTake.src,takes:[oldTake]});
      await page.setContent('<body style="background:#0c0d12;margin:40px">'+renderToStaticMarkup(tree)+'</body>');
      const before=await page.locator('.tts-generate').boundingBox();
      assert.ok(before&&before.y>=40&&before.y+before.height<=40+h,'button inside node before scrolling');
      await page.locator('.tts-controls').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      const after=await page.locator('.tts-generate').boundingBox();
      assert.equal(before.y,after.y,'scroll cannot move primary action');
      assert.equal(await page.locator('.tts-generate').evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;}),true,'button not covered');
      if(h===650)await page.screenshot({path:'runtime/voice-design-only-20261024/node-layout.png'});
    }
  }finally{await browser.close();}
}
console.log('PASS: design-only UI for legacy/new nodes, preserved takes, query-only recovery, no duplicate POST, footer layout at 650/500px (when browser argument supplied). Mock audio/GPU only.');
