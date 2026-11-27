import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import { readWorkspaceSource } from './workspace-source.mjs';
const source = readWorkspaceSource();
// K1 后 sourceH3ForDerived 在 workspace-shared.ts，restoreDerivedVideoControls 还在主文件：两段分别取。
const sliceTo = (from, to) => { const a = source.indexOf(from); return source.slice(a, source.indexOf(to, a)); };
const block = sliceTo('function sourceH3ForDerived(', '\n}\n') + '\n}\n' + sliceTo('async function restoreDerivedVideoControls(', '/** Existing canvas node for this exact output Asset');
const js = ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const original = {id:'h3',type:'h3-node',props:{w:800,h:450,prompt:'Keep <Picture 1>',roleIds:['actor'],dialogueLines:[{roleId:'actor',text:'你好'}],referenceImages:[{src:'scene-b',name:'B'}],referenceImageOrder:['file:["scene-b","B"]','node:scene-a'],seed:'123',megapixels:.5,shotId:'original-shot',previewAssetId:'old-result',sourceFrameSrc:'old-frame',sourceFrameName:'frame'}};
const hd = {id:'hd',type:'video-node',x:100,y:200,props:{w:800,h:450,src:'hd.mp4',assetId:'hd-asset',runId:'hd-run',shotId:'original-shot'}};
const image = {id:'scene-a',type:'image-node',props:{src:'scene-a',name:'A'}};
const arrow = {id:'link',type:'arrow',meta:{}};
const processing = {id:'upscale',type:'upscale-node',props:{}};
const arrow2 = {id:'source-link',type:'arrow',meta:{}};
const shapes = new Map([original,hd,image,arrow,processing,arrow2].map(s=>[s.id,s]));
const originalJSON = JSON.stringify(original);
let creates=0;
const bindings = a => a.id==='link'?{start:{toId:'upscale'},end:{toId:'hd'}}:{start:{toId:'h3'},end:{toId:'upscale'}};
const editor = {
 getShape:id=>shapes.get(id),getCurrentPageShapes:()=>[...shapes.values()],
 getShapeUtil:()=>({getDefaultProps:()=>({prompt:'',mode:'16:9'})}),
 store:{put:records=>{for(const record of records) shapes.set(record.id,record);}},
 run:fn=>fn(),select:()=>{},markHistoryStoppingPoint:()=>{},
};
const restore = new Function('getArrowBindings','getRun','getIncomingSource','getShot','getAsset','getAssetBySource','getIncomingFrameSource','getIncomingReferenceImages','createShot','showCanvasToast',js+';return restoreDerivedVideoControls;')(
 (_e,a)=>bindings(a),async()=>({capabilityId:'seedvr2_upscale'}),()=>processing,async()=>({sourceH3NodeId:'h3'}),
 async()=>({assetId:'hd-asset',storageReference:'hd.mp4',filename:'HD.mp4',sourceRunId:'hd-run',width:1920,height:1080}),async()=>null,
 ()=>null,()=>[image],async()=>{creates++;return {shotId:'new-shot'};},()=>{},
);
await restore(editor,'hd');
const result = shapes.get('hd');
assert.equal(result.type,'h3-node');
assert.equal(result.id,hd.id);assert.equal(result.x,100);assert.equal(result.y,200);
assert.equal(result.props.prompt,original.props.prompt);
assert.deepEqual(result.props.roleIds,original.props.roleIds);
assert.deepEqual(result.props.dialogueLines,original.props.dialogueLines);
assert.equal(result.props.seed,'123');
assert.deepEqual(result.props.referenceImages,[{src:'scene-b',name:'B'},{src:'scene-a',name:'A'}]);
assert.equal(result.props.sourceFrameSrc,'old-frame');
assert.equal(result.props.inheritedVideo.src,'hd.mp4');
assert.equal(result.props.inheritedVideo.assetId,'hd-asset');
assert.equal(result.props.shotId,'new-shot');assert.equal(result.props.previewAssetId,undefined);
assert.equal(JSON.stringify(original),originalJSON);
assert.equal(shapes.get('link'),arrow);
await restore(editor,'hd');assert.equal(creates,1);
assert.doesNotMatch(block,/\.generate\(|deleteShape|registerAsset|attachCompletedRunToShot/);
console.log('PASS: HD controls restored in-place, references ordered, prompt/roles/seed retained, original node/media/run/bindings unchanged, repeat-safe, no render');
