import assert from 'node:assert/strict';
import {databases} from './fake-indexeddb.mjs';
import {watchCanvasSave,confirmCanvasRecords,updatePendingRecords} from '../lib/canvas-save-status.ts';
import {VideoPlayerBudget} from '../lib/video-player-budget.ts';
import {affectedArrowIds} from '../lib/canvas-link-validation.ts';
import {subscribeLinkedContent} from '../components/canvas/linked-content.ts';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const empty=()=>({added:{},removed:{},updated:{}});
const shape=(id,type='image-node',props={})=>({id,type,typeName:'shape',props});

// Actual transaction confirmation, including a missing/deleted record.
const db=await new Promise(resolve=>{
 const request=indexedDB.open('TLDRAW_DOCUMENT_v2test',4);
 request.onupgradeneeded=()=>request.result.createObjectStore('records',{keyPath:'id'});
 request.onsuccess=()=>resolve(request.result);
});
db.close=()=>{};
const a=shape('shape:a');
const pending=new Map([['shape:a',a],['shape:deleted',undefined]]);
assert.equal(await confirmCanvasRecords('test',pending),false);
await new Promise(resolve=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put(a);tx.oncomplete=resolve;});
assert.equal(await confirmCanvasRecords('test',pending),true);
updatePendingRecords(pending,{...empty(),updated:{a:[a,{...a,props:{name:'new'}}]}});
assert.equal(await confirmCanvasRecords('test',pending),false);

// No optimistic success on a failed write or slow writer; retry may recover.
const labels=[];let persisted=false;
const save=watchCanvasSave({persistenceKey:'test',onStatus:s=>labels.push(s),delay:5,timeout:10,verify:async()=>persisted});
save.changed({...empty(),added:{'shape:a':a}});
await pause(30);assert.equal(save.hasPending(),true);assert(!labels.includes('画布已保存'));assert(labels.includes('保存尚未确认，请导出备份'));
persisted=true;await pause(20);assert.equal(save.hasPending(),false);assert.equal(labels.at(-1),'画布已保存');save.close();
const errors=[];
const failure=watchCanvasSave({persistenceKey:'test',delay:5,onStatus:s=>errors.push(s),verify:async()=>{throw Error('quota');}});
failure.changed({...empty(),added:{a}});await pause(15);assert(errors.includes('保存核实失败，请导出备份'));assert(failure.hasPending());failure.close();
let finish;const staleLabels=[];let checks=0;
const stale=watchCanvasSave({persistenceKey:'test',delay:5,onStatus:s=>staleLabels.push(s),verify:()=>++checks===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve(false)});
stale.changed({...empty(),added:{a}});await pause(10);stale.changed({...empty(),added:{b:shape('b')}});finish(true);await pause(15);
assert(!staleLabels.includes('画布已保存'),'an old commit cannot mark new edits saved');stale.close();

// Real cold cache reload, no original video database changes.
const warm=await import('../lib/poster-cache.ts?warm');
warm.rememberPoster('media:persistent','data:image/jpeg;base64,first');await pause(10);
const cold=await import('../lib/poster-cache.ts?cold');
assert.equal(cold.getPoster('media:persistent'),undefined);
assert.equal(await cold.loadPoster('media:persistent'),'data:image/jpeg;base64,first');
let notified=0;const off=cold.subscribePoster('media:persistent',()=>notified++);
cold.rememberPoster('media:persistent','data:image/jpeg;base64,new');assert.equal(notified,1);off();
cold.rememberPoster('media:persistent','data:image/jpeg;base64,newer');assert.equal(notified,1);await pause(10);
assert(!databases.has('frameflow-local-media'),'poster cache does not migrate or rewrite video storage');

// 100 eligible players => <=3 background/selected decoders; playing stays alive.
const budget=new VideoPlayerBudget(3),active=new Set(),releases=[];
for(let i=0;i<100;i++)releases.push(budget.request({i},1,value=>value?active.add(i):active.delete(i)));
assert.equal(active.size,3);
const selection=budget.request({},10,value=>value?active.add('selected'):active.delete('selected'));
assert(active.has('selected'));assert.equal(active.size,3);
const playing=budget.request({},100,value=>value?active.add('playing'):active.delete('playing'));
assert(active.has('playing'));assert.equal(active.size,3);
selection();assert(active.has('playing'));playing();releases.forEach(release=>release());assert.equal(active.size,0);

// Incremental link validator never traverses nodes for a move or prompt edit.
let scans=0;const arrows=id=>{scans++;return ['arrow:linked'];};
assert.deepEqual([...affectedArrowIds({...empty(),updated:{a:[a,{...a,x:100}]}},arrows)],[]);
assert.deepEqual([...affectedArrowIds({...empty(),updated:{a:[a,{...a,props:{prompt:'new'}}]}},arrows)],[]);
assert.equal(scans,0);
const binding={id:'binding:a',typeName:'binding',type:'arrow',fromId:'arrow:a',toId:'shape:a',props:{terminal:'start'}};
assert.deepEqual([...affectedArrowIds({...empty(),added:{[binding.id]:binding}},arrows)],['arrow:a']);
assert.deepEqual([...affectedArrowIds({...empty(),updated:{a:[a,{...a,type:'video-node'}]}},arrows)],['arrow:linked']);

// Shared subscriptions: only connected nodes update; link deletion/undo rebuild dependencies.
const shapes=new Map([['shape:a',a],['shape:b',shape('shape:b','h3-node')],['shape:c',shape('shape:c','h3-node')],['arrow:a',shape('arrow:a','arrow')]]);
let bindings=[binding,{...binding,id:'binding:b',toId:'shape:b',props:{terminal:'end'}}];
let listener,subscriptions=0,closed=0;
const editor={getShape:id=>shapes.get(id),getBindingsToShape:id=>bindings.filter(b=>b.toId===id),getBindingsFromShape:id=>bindings.filter(b=>b.fromId===id),store:{listen:callback=>{listener=callback;subscriptions++;return()=>closed++;}}};
let bUpdates=0,cUpdates=0;
const stopB=subscribeLinkedContent(editor,'shape:b',()=>bUpdates++),stopC=subscribeLinkedContent(editor,'shape:c',()=>cUpdates++);
assert.equal(subscriptions,1);
listener({changes:{...empty(),updated:{'shape:a':[a,{...a,props:{src:'new'}}]}}});assert.equal(bUpdates,1);assert.equal(cUpdates,0);
const removed=bindings[1];bindings=bindings.slice(0,1);
listener({changes:{...empty(),removed:{[removed.id]:removed}}});assert.equal(bUpdates,2);
listener({changes:{...empty(),updated:{'shape:a':[a,{...a,props:{src:'newer'}}]}}});assert.equal(bUpdates,2,'disconnected source stops notifying');
bindings.push(removed);listener({changes:{...empty(),added:{[removed.id]:removed}}});assert.equal(bUpdates,3,'undo restored connection notifies');
stopB();stopC();assert.equal(closed,1);
console.log('PASS five improvements: committed-save verification/errors/races; persistent cold posters; bounded players; incremental edges; shared scoped node subscriptions/undo/cleanup (no browser/GPU).');
