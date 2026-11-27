import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { snapMediaRect, visibleMediaRect } from '../lib/media-magnet.ts';

const target = { x: 0, y: 0, w: 100, h: 200 };
let snap = snapMediaRect({ x: 117, y: 3, w: 100, h: 200 }, [target], 1);
assert.equal(snap.dx, -5); assert.equal(snap.dy, -3);
assert.equal(snap.guides.length, 2);
snap = snapMediaRect({ x: -116, y: 0, w: 100, h: 200 }, [target], 1);
assert.equal(snap.dx, 4);
snap = snapMediaRect({ x: 2, y: 216, w: 100, h: 200 }, [target], 1);
assert.equal(snap.dx, -2); assert.equal(snap.dy, -4);
snap = snapMediaRect({ x: 117, y: 3, w: 100, h: 200 }, [target], 2);
assert.equal(snap.dx, 0); // attraction distance remains eight screen pixels
snap = snapMediaRect({ x: 127, y: 20, w: 100, h: 200 }, [target], 1);
assert.equal(snap.dx, 0); assert.equal(snap.dy, 0); // released, no sticky last position
snap = snapMediaRect({ x: 5000, y: 2, w: 100, h: 200 }, [target], 1);
assert.equal(snap.dy, 0); // a remote node cannot attract
snap = snapMediaRect({ x: 113, y: 54, w: 100, h: 100 }, [target], 1);
assert.equal(snap.dy, -4); // centre alignment, unequal media dimensions
assert.deepEqual(visibleMediaRect({ type:'h3-node', x:10, y:20, props:{w:700,h:1200,previewWidth:300,previewHeight:500} }), {x:210,y:52,w:300,h:500});
assert.deepEqual(visibleMediaRect({ type:'video-node', x:10, y:20, props:{w:300,h:532} }), {x:10,y:52,w:300,h:500});
assert.equal(visibleMediaRect({type:'arrow',x:0,y:0,props:{}}), undefined);
assert.equal(visibleMediaRect({type:'h3-node',x:0,y:0,props:{w:700,h:1200}}), undefined);
console.log('Media magnetic gap, edge/centre alignment, zoom, release and preview bounds passed.');

// Exercise the actual shape-util adapter with a minimal editor, not a second implementation.
const source = (await readFile(new URL('../components/canvas/media-magnet.ts', import.meta.url), 'utf8'))
  .replace('"../../lib/media-magnet"', JSON.stringify(new URL('../lib/media-magnet.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { startMediaMagnet, translateMediaMagnet, endMediaMagnet } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const a = { id:'shape:a', type:'video-node', parentId:'page:a', rotation:0, x:117,y:3,props:{w:100,h:232} };
const b = { ...a,id:'shape:b',x:0,y:0 };
let selected=[a.id], indicators=[], scans=0, modifier=false;
const editor={
  getSelectedShapeIds:()=>selected,
  getSortedChildIdsForParent:()=>{scans++;return [a.id,b.id];},
  getShape:id=>id===a.id?a:b, getZoomLevel:()=>1,
  getShapeParentTransform:()=>({applyToPoint:p=>({x:p.x+50,y:p.y+60})}),
  inputs:{getAltKey:()=>modifier,getCtrlKey:()=>false,getShiftKey:()=>false},
  snaps:{setIndicators:next=>{indicators=next;},clearIndicators:()=>{indicators=[];}},
};
startMediaMagnet(editor,a);
assert.deepEqual(translateMediaMagnet(editor,a),{id:a.id,type:a.type,x:112,y:0});
assert.equal(indicators.length,2);
assert.ok(indicators.every(g=>g.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))));
translateMediaMagnet(editor,{...a,x:127,y:20}); assert.equal(indicators.length,0);
assert.equal(scans,1); // targets collected once per drag, not per pointer movement
modifier=true;assert.equal(translateMediaMagnet(editor,a),undefined);modifier=false;
endMediaMagnet(editor); assert.equal(indicators.length,0); assert.equal(translateMediaMagnet(editor,a),undefined);
selected=[a.id,b.id];startMediaMagnet(editor,a);assert.equal(translateMediaMagnet(editor,a),undefined);
selected=[a.id];startMediaMagnet(editor,{...a,rotation:1});assert.equal(translateMediaMagnet(editor,a),undefined);
console.log('Actual drag adapter: lifecycle, group preservation, modifiers, guides and one target scan passed.');
