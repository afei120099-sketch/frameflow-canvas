import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import ts from 'typescript';
import { clipboardImages, canvasImageClipboardHtml, readCanvasImageClipboardHtml, canvasImagePasteOverride, pngWithCanvasContent, readCanvasImagePng } from '../lib/canvas-image-clipboard.ts';
const shape={id:'shape:one',type:'image-node',props:{src:'image:one',name:'角色甲 <原图> & "参考"',assetId:'asset-one'}};
const content={shapes:[shape],rootShapeIds:[shape.id],bindings:[],assets:[],schema:{schemaVersion:2}};
const png='data:image/png;base64,iVBORw0KGgo=';
assert.equal(clipboardImages([]),null);
assert.equal(clipboardImages([{type:'h3-node',props:{src:'test'}}]),null);
assert.equal(clipboardImages([shape,{type:'text',props:{}}]),null);
assert.equal(clipboardImages([{type:'flux-image-node',props:{src:''}}]),null);
assert.deepEqual(clipboardImages([shape]),[{src:'image:one',name:shape.props.name}]);
const html=canvasImageClipboardHtml(content,png);
assert.ok(html.includes('<img src="data:image/png;base64,'));
assert.ok(!html.includes('角色甲')); // Internal JSON never appears as visible rich text.
assert.deepEqual(readCanvasImageClipboardHtml(html),content);
assert.equal(readCanvasImageClipboardHtml('<div>ordinary external image</div>'),null);
assert.equal(readCanvasImageClipboardHtml('data-frameflow-image-content="e30="'),null);
assert.throws(()=>canvasImageClipboardHtml(content,'javascript:alert(1)'));
const paste={type:'files',files:[{}],point:{x:1,y:2},sources:[{type:'text',subtype:'html',data:html}]};
assert.deepEqual(canvasImagePasteOverride(paste),{type:'tldraw',content,point:paste.point});
assert.equal(canvasImagePasteOverride({...paste,sources:[]}),undefined);
assert.equal(canvasImagePasteOverride({type:'text',sources:paste.sources}),undefined);
const samplePng=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
const tagged=pngWithCanvasContent(samplePng,content);
assert.deepEqual(readCanvasImagePng(tagged),content);
assert.equal(readCanvasImagePng(samplePng),null);
assert.ok(tagged.length>samplePng.length);
assert.ok(tagged.buffer instanceof ArrayBuffer,'encoded PNG owns an ordinary ArrayBuffer accepted by Blob');
const padded=new Uint8Array(samplePng.length+8);padded.set(samplePng,4);
assert.deepEqual(pngWithCanvasContent(padded.subarray(4,4+samplePng.length),content),tagged,'byte offsets do not include surrounding bytes');
if(typeof SharedArrayBuffer!=='undefined'){
  const shared=new Uint8Array(new SharedArrayBuffer(samplePng.length));shared.set(samplePng);
  const owned=pngWithCanvasContent(shared,content);
  assert.ok(owned.buffer instanceof ArrayBuffer,'shared inputs are copied into ordinary owned output storage');
  assert.deepEqual(owned,tagged);
  assert.equal(new Blob([owned],{type:'image/png'}).size,tagged.length);
}
let pngAt=8;
while(pngAt+12<=tagged.length){
  const size=new DataView(tagged.buffer,tagged.byteOffset+pngAt,4).getUint32(0);
  const actual=crc32(tagged.subarray(pngAt+4,pngAt+8+size))>>>0;
  const expected=new DataView(tagged.buffer,tagged.byteOffset+pngAt+8+size,4).getUint32(0);
  assert.equal(actual,expected,`PNG chunk CRC at ${pngAt}`);
  const type=String.fromCharCode(tagged[pngAt+4],tagged[pngAt+5],tagged[pngAt+6],tagged[pngAt+7]);
  pngAt+=12+size;
  if(type==='IEND') break;
}
assert.equal(pngAt,tagged.length,'tagged PNG ends on IEND');

const originalBlob=new Blob([samplePng],{type:'image/png'});
let fetches=0,posts=[],notice=[],draws=[],closed=0;
globalThis.__clipRead=async()=>{fetches++;return originalBlob;};
globalThis.__clipNotice=message=>notice.push(message);
globalThis.fetch=async(url,init)=>{posts.push({url,body:init?.body});return {ok:url==='/__clipboard/image'&&init?.method==='POST'&&init.body?.type==='image/png',text:async()=>''};};
let source=await readFile(new URL('../components/canvas/image-clipboard.ts',import.meta.url),'utf8');
source=source.replace(/import \{ getLocalImageBlob \} from [^;]+;/,'const getLocalImageBlob = globalThis.__clipRead;')
 .replace(/from '\.\.\/\.\.\/lib\/canvas-image-clipboard'/,`from ${JSON.stringify(new URL('../lib/canvas-image-clipboard.ts',import.meta.url).href)}`)
 .replace(/import \{ showCanvasToast \} from [^;]+;/,'const showCanvasToast = globalThis.__clipNotice;');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {canvasImageClipboardOptions:hooks,clipboardPng}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const pending=hooks.onBeforeCopyToClipboard({content,operation:'copy'});
assert.equal(await pending,false,'the ordinary text-only write must not overwrite the picture');
assert.equal(posts.length,1);
assert.equal(posts[0].url,'/__clipboard/image');
const writtenPng=new Uint8Array(await posts[0].body.arrayBuffer());
assert.deepEqual(readCanvasImagePng(writtenPng),content,'picture still carries the canvas nodes');
assert.equal(await hooks.onBeforePasteFromClipboard({content:{type:'files',files:[new Blob([writtenPng],{type:'image/png'})],point:{x:3,y:4},sources:[]}}),false,'pasting the copied picture must not create another canvas node');
assert.equal(await hooks.onBeforePasteFromClipboard({content:{type:'files',files:[originalBlob],point:{x:3,y:4},sources:[]}}),undefined);
assert.equal(await hooks.onBeforePasteFromClipboard({content:{...paste,sources:[{type:'text',subtype:'html',data:html}]}}),false);
assert.equal(hooks.onBeforeCopyToClipboard({content,operation:'cut'}),undefined);
assert.equal(hooks.onBeforeCopyToClipboard({content:{...content,shapes:[{type:'text',props:{}}]},operation:'copy'}),undefined);
assert.equal(posts.length,1,'cut and text use the original tldraw implementation');

let browserWrites=0;
globalThis.ClipboardItem=class { constructor(data){this.data=data;} };
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{write:async items=>{
  browserWrites++;
  assert.deepEqual(readCanvasImagePng(new Uint8Array(await (await items[0].data['image/png']).arrayBuffer())),content);
}}}});
assert.equal(await hooks.onBeforeCopyToClipboard({content,operation:'copy'}),false);
assert.equal(browserWrites,1);
assert.equal(posts.length,1,'browser success does not call or start helper');
navigator.clipboard.write=()=>{throw Error('permission denied');};
assert.equal(await hooks.onBeforeCopyToClipboard({content,operation:'copy'}),false);
assert.equal(posts.length,2,'synchronous browser denial uses automatic helper');
navigator.clipboard.write=async()=>{throw Error('permission denied');};
assert.equal(await hooks.onBeforeCopyToClipboard({content,operation:'copy'}),false);
assert.equal(posts.length,3,'asynchronous browser denial uses automatic helper');
globalThis.fetch=async()=>({ok:false,text:async()=>'复制助手未启动'});
assert.equal(await hooks.onBeforeCopyToClipboard({content,operation:'copy'}),false,'a failed picture copy must not fall back to duplicating the node');
assert.ok(notice.at(-1).includes('图片复制失败'));
assert.equal(notice.at(-1).includes('普通节点'),false);
globalThis.createImageBitmap=async()=>({width:3,height:2,close:()=>closed++});
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({drawImage:(_image,x,y)=>draws.push([x,y])}),toBlob:cb=>cb(new Blob(['png'],{type:'image/png'}))})};
assert.equal((await clipboardPng(['one','two'])).type,'image/png');
assert.deepEqual(draws,[[0,0],[3,0]]);assert.equal(closed,2);
assert.ok(fetches>0);
console.log('Image clipboard: picture-only clipboard, PNG metadata roundtrip, node preservation, text/cut fallback, permission failure and multi-image composition passed.');
