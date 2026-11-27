import assert from 'node:assert/strict';
import {canvasName,waitForCanvasSave,requireCanvasSwitchIdle} from '../lib/canvas-library.ts';
assert.doesNotThrow(()=>requireCanvasSwitchIdle(false,false));
assert.throws(()=>requireCanvasSwitchIdle(true,false),/正在渲染/);
assert.throws(()=>requireCanvasSwitchIdle(false,true),/批量排队/);
assert.equal(canvasName(' 装修视频 ',['人物短片']),'装修视频');
assert.throws(()=>canvasName(' '),/名称/);
assert.throws(()=>canvasName('x'.repeat(61)),/名称/);
assert.throws(()=>canvasName('装修视频',['装修视频']),/已存在/);
assert.throws(()=>canvasName('VIDEO',['video']),/已存在/);
assert.equal(canvasName('装修视频',['装修视频'],'装修视频'),'装修视频');
let calls=0;
const records=new Map([['page:test',{id:'page:test',name:'装修视频'}]]);
await waitForCanvasSave('existing',records,{verify:async(key,pending)=>{assert.equal(key,'existing');assert.equal(pending,records);return ++calls===3;},wait:async()=>{},attempts:4});
assert.equal(calls,3);
await assert.rejects(()=>waitForCanvasSave('existing',records,{verify:async()=>false,wait:async()=>{},attempts:2}),/尚未确认.*未提交新任务/);
await assert.rejects(()=>waitForCanvasSave('existing',records,{verify:async()=>{throw Error('storage blocked');},wait:async()=>{}}),/storage blocked/);
// A decoded frame changes preview dimensions while the old snapshot is waiting.
let live={id:'shape:tail',props:{frame:'pinned-frame',previewHeight:100}};
const frozen=new Map([['shape:tail',live]]);
calls=0;
await waitForCanvasSave('existing',frozen,{attempts:3,wait:async()=>{},readRecords:()=>new Map([['shape:tail',live]]),verify:async(_key,pending)=>{
  calls++;
  if(calls===1){live={...live,props:{...live.props,previewHeight:200}};return false;}
  assert.equal(pending.get('shape:tail').props.previewHeight,200);
  assert.equal(pending.get('shape:tail').props.frame,'pinned-frame');return true;
}});
assert.equal(calls,2);
// A commit for the previous revision must not certify a newly edited record.
calls=0;
await waitForCanvasSave('existing',frozen,{attempts:3,wait:async()=>{},readRecords:()=>new Map([['shape:tail',live]]),verify:async()=>{
  if(++calls===1)live={...live,props:{...live.props,frame:'new-frame'}};
  return true;
}});
assert.equal(calls,2);
await assert.rejects(()=>waitForCanvasSave('existing',frozen,{attempts:2,wait:async()=>{},readRecords:()=>new Map([['shape:tail',live]]),verify:async()=>false}),/尚未确认写入本机存储/);
console.log('PASS canvas save: current-record refresh, commit races, fail-closed writes, names and switch guard. CPU/mock only.');
