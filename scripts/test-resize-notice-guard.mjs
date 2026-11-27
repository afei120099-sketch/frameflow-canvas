import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {RESIZE_NOTICE_GUARD_SCRIPT,installResizeNoticeGuard} from '../lib/resize-notice-guard.ts';
function check(install){
 const listeners=[],window={addEventListener:(kind,listener,capture)=>listeners.push({kind,listener,capture})};
 install(window);install(window);assert.equal(listeners.length,1,'deduplicated across reloads');
 assert.equal(listeners[0].capture,true);
 for(const message of ['ResizeObserver loop completed with undelivered notifications.','ResizeObserver loop limit exceeded','  ResizeObserver loop limit exceeded.  ','Uncaught Error: ResizeObserver loop completed with undelivered notifications.']){
  const calls=[];listeners[0].listener({message,preventDefault:()=>calls.push('prevent'),stopImmediatePropagation:()=>calls.push('stop')});assert.deepEqual(calls,['prevent','stop']);
 }
 for(const message of ['TypeError: cannot read properties of undefined','CUDA out of memory','ResizeObserver other failure','Script error.']){
  const calls=[];listeners[0].listener({message,preventDefault:()=>calls.push(1),stopImmediatePropagation:()=>calls.push(2)});assert.equal(calls.length,0,'real errors must still surface');
 }
 const calls=[];listeners[0].listener({message:'',error:{message:'ResizeObserver loop limit exceeded'},preventDefault:()=>calls.push(1),stopImmediatePropagation:()=>calls.push(2)});assert.equal(calls.length,2);
}
check(window=>runInNewContext(RESIZE_NOTICE_GUARD_SCRIPT,{window}));
check(window=>{globalThis.window=window;installResizeNoticeGuard();delete globalThis.window;});
const layout=readFileSync(new URL('../app/layout.tsx',import.meta.url),'utf8');
assert.ok(layout.indexOf('__html:RESIZE_NOTICE_GUARD_SCRIPT')<layout.indexOf('__ffSend'),'installed before existing error reporting');
console.log('PASS early/late precise ResizeObserver notice suppression, deduplicated, other JS/errors preserved');
