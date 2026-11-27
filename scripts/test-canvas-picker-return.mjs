import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../app/canvas-workspace.tsx',import.meta.url),'utf8');
const start=source.indexOf('const returnFromCanvasPicker=()=>{');
const end=source.indexOf('const chooseCanvasMedia=',start);
assert(start>=0&&end>start);
const events=[],replacingReference={current:{kind:'referenceImages',index:0}};
let exists=true;
const finish=runInNewContext(source.slice(start,end)+';returnFromCanvasPicker;',{
  replacingReference,shape:{id:'original-video-node'},
  editor:{getShape:()=>exists,select:id=>events.push(['select',id])},
  setCanvasReferencePicker:value=>events.push(['referencePicker',value]),
  setFramePicker:value=>events.push(['framePicker',value]),
  setDockOpen:value=>events.push(['dock',value]),
});
finish();
assert.equal(replacingReference.current,null);
assert.equal(JSON.stringify(events),JSON.stringify([['referencePicker',null],['framePicker',null],['select','original-video-node'],['dock',true]]));
events.length=0;exists=false;finish();assert(!events.some(e=>e[0]==='select'||e[0]==='dock'));
const choose=source.slice(end,source.indexOf('const removeConnectedReference',end));
assert.match(choose,/returnFromCanvasPicker\(\)/);
assert.match(source,/onClose=\{returnFromCanvasPicker\}/);
assert.match(source,/data-h3-picker-for=\{ownerNodeId\}/);
assert.match(source,/dataset\.h3PickerFor===shape\.id/);
assert.match(source,/!selected && !referenceDragHold && !pickerOpen/);
console.log('PASS: picker success/cancel restores original node and open dock; deleted-node guard; portal ownership and selection guard. No media mutation or GPU.');
