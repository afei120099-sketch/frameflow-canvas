import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function environment(hidden=true, fallback=true) {
  let clock=0,sequence=0;
  const timers=new Map(),nativeFrames=new Map(),events=new Map();
  const document={hidden,addEventListener:(name,fn)=>events.set(name,fn)};
  const window={requestAnimationFrame:fn=>{const id=++sequence;nativeFrames.set(id,fn);return id;},cancelAnimationFrame:id=>nativeFrames.delete(id)};
  const context=vm.createContext({window,document,performance:{now:()=>clock},Map,Promise,JSON,Error,
    setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{at:clock+delay,fn});return id;},clearTimeout:id=>timers.delete(id)});
  const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  vm.runInContext(compile(readFileSync('lib/canvas-background-work.ts','utf8').replace('export async function','async function')),context);
  if(!fallback)vm.runInContext('withCanvasBackgroundWork=async work=>work()',context);
  const source=readFileSync('lib/canvas-library.ts','utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export ', '');
  vm.runInContext(compile(source)+'\nglobalThis.waitForSave=waitForCanvasSave;globalThis.work=withCanvasBackgroundWork;',context);
  const advance=async(ms)=>{clock+=ms;for(const [id,timer] of [...timers])if(timer.at<=clock){timers.delete(id);timer.fn();}await Promise.resolve();};
  return {window,document,context,advance,nativeFrames,events};
}

// Reproduce the original pause: tldraw's notification never reaches its real
// writer while rAF is suspended. This mock is CPU-only, not online IDB proof.
for(const fallback of [false,true]){
  const env=environment(true,fallback);let persisted=false,calls=0;
  env.window.requestAnimationFrame(()=>{calls++;persisted=true;});
  const save=env.context.waitForSave('test',new Map([['shape:tail',{src:'pinned-HD'}]]),
    {attempts:3,verify:async()=>persisted,wait:env.advance});
  if(fallback){await save;assert.equal(calls,1);assert.equal(env.nativeFrames.size,0);}
  else{await assert.rejects(save,/尚未确认写入/);assert.equal(calls,0);}
}
// A native rAF racing the fallback fires exactly once; cancelled work stays cancelled.
const race=environment();let called=0;
const frameId=race.window.requestAnimationFrame(()=>called++);
const pending=race.context.work(async()=>{const native=[...race.nativeFrames.values()][0];native(0);await race.advance(20);});
await pending;assert.equal(called,1);
const cancelled=race.window.requestAnimationFrame(()=>called++);race.window.cancelAnimationFrame(cancelled);
await race.advance(20);assert.equal(called,1);assert.ok(frameId);
// Visible tabs use native rAF, and a tab becoming hidden while saving is supported.
const visible=environment(false);let flushed=false;
visible.window.requestAnimationFrame(()=>flushed=true);
await visible.context.work(()=>visible.advance(20));assert.equal(flushed,false);
visible.document.hidden=true;visible.events.get('visibilitychange')();await visible.advance(20);assert.equal(flushed,true);
// No false save success: even with the fallback active, a real mismatch still blocks.
const missing=environment();
await assert.rejects(()=>missing.context.waitForSave('test',new Map(),{attempts:2,verify:async()=>false,wait:missing.advance}),/未提交新任务/);
console.log('PASS hidden-tab save: old failure reproduced, pending store callback released, native/fallback once, cancel, visibility transition, mismatch remains blocked; CPU only, no network/GPU.');
