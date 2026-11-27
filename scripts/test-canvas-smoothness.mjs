import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeCanvasSmoothness } from './normalize-canvas-smoothness.mjs';
import { normalizeQueueFrameNode } from './normalize-queue-frame-node.mjs';
import { assertQueueLifecyclePreserved } from './queue-lifecycle-preservation.mjs';

const read = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const before = execFileSync('git', ['show', '96ac6e1:app/canvas-workspace.tsx'], {encoding:'utf8'}).replaceAll('\r\n','\n');
const after = read('app/canvas-workspace.tsx');
assert.equal(normalizeCanvasSmoothness(normalizeQueueFrameNode(after)), before, 'entire workspace unchanged except exact selectors and separately authorized frame guard/display/token');
assertQueueLifecyclePreserved(read('components/use-shot-queue-execution.ts'),execFileSync('git',['show','96ac6e1:components/use-shot-queue-execution.ts'],{encoding:'utf8'}));
for (const path of ['app/globals.css', 'components/canvas/media-hooks.ts', 'lib/media-node-layout.ts', 'lib/h3-node-layout-policy.ts']) {
  assert.equal(read(path), execFileSync('git',['show',`96ac6e1:${path}`],{encoding:'utf8'}).replaceAll('\r\n','\n'), `${path} unchanged`);
}
// Use the actual installed tldraw reactive engine, not a home-made equality mock.
const {atom, computed, react} = createRequire(import.meta.resolve('tldraw'))('@tldraw/state');
function callback(source, label) {
  const ast = ts.createSourceFile('workspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = n => {
    if (ts.isCallExpression(n) && n.expression.getText(ast)==='useValue' && n.arguments[0]?.text===label) found=n.arguments[1].getText(ast);
    ts.forEachChild(n, visit);
  }; visit(ast); assert.ok(found, label); return found;
}
const getFunction = (source,name) => {
  const ast=ts.createSourceFile('w.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  return ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);
};
const compile = (text, context) => vm.runInContext(ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, vm.createContext(context));
const shape = (id, type, src) => ({id,type,props:{src,name:id,filename:id,size:'1024x1024',candidates:[]}});
const fixtures=[shape('img','image-node','media:img'),shape('video','video-node','media:video'),shape('voice','audio-node','audio:voice'),shape('tts','tts-node','audio:tts'),shape('music','music-node','audio:music'),shape('empty','h3-node','')];

const results=[];
for (const count of [100,300,500]) {
  const zoom=atom(`zoom-${count}`,1),page=atom(`page-${count}`,fixtures);
  const samples=Array.from({length:120},(_,i)=>0.8+i/1000);
  for(const [name,source] of [['before',before],['after',after]]) {
    zoom.set(1); let scans=0, zoomUpdates=0, pickerUpdates=0;
    const editor={getZoomLevel:()=>zoom.get(),getCurrentPageShapes:()=>{scans++;return page.get();}};
    const context={editor,framePicker:null,canvasReferencePicker:null};
    compile(getFunction(after,'referenceImageOf')+';globalThis.referenceImageOf=referenceImageOf;',context);
    const detail=compile('('+callback(source,'frameflow semantic node zoom')+')',context);
    const picker=compile('('+callback(source,'existing canvas reference media')+')',context);
    const cleanups=[];
    for(let i=0;i<count;i++) {
      const d=computed(`${name}-detail-${i}`,detail), p=computed(`${name}-picker-${i}`,picker);
      cleanups.push(react(`${name}-consumer-${i}`,()=>{d.get();zoomUpdates++;}),react(`${name}-picker-consumer-${i}`,()=>{p.get();pickerUpdates++;}));
    }
    const initialScans=scans;
    for(const value of samples)zoom.set(value);
    for(let i=0;i<20;i++)page.set(fixtures.map((s,index)=>({...s,x:index+i})));
    results.push({nodes:count,version:name,zoomConsumerUpdates:zoomUpdates-count,closedPickerScans:scans,initialScans,pickerConsumerUpdates:pickerUpdates-count});
    if(name==='after'){assert.equal(scans,0);assert.equal(zoomUpdates,count);assert.equal(pickerUpdates,count);}
    else {assert.equal(zoomUpdates-count,count*samples.length);assert.equal(scans,count*21);}
    cleanups.forEach(off=>off());
  }
}
// Boundary semantics stay exactly the same. React consumers update only at a boundary.
{
  const zoom=atom('boundaries',0.47),context={editor:{getZoomLevel:()=>zoom.get()}};
  const d=computed('detail',compile('('+callback(after,'frameflow semantic node zoom')+')',context)), seen=[];
  const off=react('boundary-consumer',()=>seen.push(d.get()));
  for(const value of [0.479,0.48,0.6,0.719,0.72,1,0.71,0.47])zoom.set(value);
  off();assert.deepEqual(seen,['far','mid','near','mid','far']);
}
// Every picker kind sees current sources, adopts Flux's selected candidate and follows page changes.
for (const [framePicker,canvasReferencePicker] of [['first',null],['last',null],[null,'referenceImages'],[null,'referenceVideos'],[null,'referenceAudios']]) {
  let scans=0;const page=atom('open-page',fixtures),context={framePicker,canvasReferencePicker,editor:{getCurrentPageShapes:()=>{scans++;return page.get();}}};
  compile(getFunction(after,'referenceImageOf')+';globalThis.referenceImageOf=referenceImageOf;',context);
  const current=computed('open-picker',compile('('+callback(after,'existing canvas reference media')+')',context));
  assert.deepEqual(JSON.parse(JSON.stringify(current.get())),JSON.parse(JSON.stringify(compile('('+callback(before,'existing canvas reference media')+')',context)())));
  const flux=shape('flux','flux-image-node','media:fallback');flux.props.adoptedAssetId='adopted';flux.props.candidates=[{assetId:'adopted',src:'media:adopted',filename:'chosen.png'}];
  page.set([flux]);assert.equal(current.get()[0].src,'media:adopted');
  page.set([shape('other-page','image-node','media:other')]);assert.equal(current.get()[0].src,'media:other');
  page.set([]);assert.equal(current.get().length,0);assert.ok(scans>=4);
}
console.log(JSON.stringify({kind:'actual selectors + installed tldraw signals; not browser FPS',results},null,2));
console.log('PASS: closed picker does not read/subscribe to shapes; same-band zoom avoids consumer updates; thresholds, all picker kinds, adopted media, page replacement, deletion and whole-file preservation');
