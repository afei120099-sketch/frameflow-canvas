import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { H3_NEW_NODE_WIDTH, H3_NEW_NODE_HEIGHT, H3_NEW_LAYOUT_META, hasNewH3Layout, usesWideH3Typography, h3AutoHeightPatch } from '../lib/h3-node-layout-policy.ts';

assert.equal(H3_NEW_NODE_WIDTH,717); assert.equal(H3_NEW_NODE_HEIGHT,824);
for(const meta of [undefined,{}, {h3LayoutVersion:1}]) {
  assert.equal(hasNewH3Layout(meta),false);
  for(const w of [220,559,560,717,1000]) assert.equal(usesWideH3Typography(meta,w),false,'old wide cards do not silently opt in');
  for(const h of [100,644,900,2000]) assert.deepEqual(h3AutoHeightPatch(meta,644,h),{},'legacy height is never auto-fitted');
}
assert.equal(usesWideH3Typography(H3_NEW_LAYOUT_META,717),true);
assert.equal(usesWideH3Typography(H3_NEW_LAYOUT_META,560),false);
assert.deepEqual(h3AutoHeightPatch(H3_NEW_LAYOUT_META,824,1000),{h:1000});
assert.deepEqual(h3AutoHeightPatch(H3_NEW_LAYOUT_META,824,NaN),{});
assert.equal(usesWideH3Typography(JSON.parse(JSON.stringify(H3_NEW_LAYOUT_META)),717),true,'explicit layout survives save/restore');
const source=readFileSync(new URL('../app/canvas-workspace.tsx',import.meta.url),'utf8').replaceAll('\r\n','\n');
const parsed=ts.createSourceFile('workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let factory;
const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='createH3Node')factory=node.getText(parsed);ts.forEachChild(node,visit);}; visit(parsed);
assert.ok(factory);
const records=new Map([['old',{id:'old',type:'h3-node',x:17,y:29,props:{w:431,h:643},meta:{}}]]);
const old=structuredClone(records.get('old'));
const context=vm.createContext({H3_NODE_WIDTH:H3_NEW_NODE_WIDTH,H3_DEFAULT_HEIGHT:H3_NEW_NODE_HEIGHT,H3_NEW_LAYOUT_META,
  createShapeId:()=> 'new',createShot:async()=>({shotId:'test-only'}),linkShotToH3Node:async()=>({shotId:'test-only'})});
const fn=vm.runInContext(ts.transpileModule(`${factory}; createH3Node;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
await fn({createShape:s=>records.set(s.id,structuredClone(s)),getShape:id=>records.get(id)},{x:123,y:456});
assert.deepEqual(records.get('old'),old);
assert.equal(records.get('new').props.w,717); assert.equal(records.get('new').props.h,824);
assert.equal(records.get('new').meta.h3LayoutVersion,2);
assert.equal(records.get('new').x,123); assert.equal(records.get('new').y,456);
assert.doesNotMatch(source,/if \(shape\.props\.w < H3_NODE_WIDTH\)/,'no mount-time width migration');
assert.match(source,/props: \{ storyboardGuides: next \}/,'guide conversion cannot increase width');
assert.doesNotMatch(source,/storyboardGuides: next, w:/);
assert.match(source,/Object\.assign\(props, h3AutoHeightPatch\(current\.meta, current\.props\.h, height\)\)/);
assert.match(source,/wideH3=\{usesWideH3Typography\(shape\.meta, shape\.props\.w\)\}/);
const baseline=path=>execFileSync('git',['show',`55ff961:${path}`],{encoding:'utf8',windowsHide:true}).replaceAll('\r\n','\n');
assert.equal(readFileSync(new URL('../lib/media-node-layout.ts',import.meta.url),'utf8').replaceAll('\r\n','\n'),baseline('lib/media-node-layout.ts'));
const geom=s=>s.slice(s.indexOf('  override getGeometry(shape: H3Node)'),s.indexOf('static override props =',s.indexOf('  override getGeometry(shape: H3Node)'))).trim();
assert.equal(geom(source),geom(baseline('app/canvas-workspace.tsx')),'media hit bounds/arrow geometry unchanged');
const css=readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
const block=css.match(/\/\* Batch C scoped typography: begin \*\/[\s\S]*?\/\* Batch C scoped typography: end \*\//)?.[0];
assert.ok(block);
const postcss=createRequire(import.meta.resolve('vite'))('postcss'); let fonts=0;
postcss.parse(block).walkRules(rule=>{
  for(const selector of rule.selectors) assert.ok(selector.startsWith('.h3-preview-node .node-shell'),selector);
  rule.walkDecls(decl=>{
    assert.ok(['--node-fs','font-size','color'].includes(decl.prop),'no layout declarations in typography rules');
    if(decl.prop==='font-size'||decl.prop==='color')assert.ok(rule.selectors.every(s=>s.includes('[data-node-wide="true"]')),'legacy cards cannot match scaled/colour rules');
    if(decl.prop==='font-size'){assert.match(decl.value,/^calc\(\d+px \* var\(--node-fs\)\)$/);fonts++;}
  });
});
assert.equal(fonts,17);
const structure=n=>n.type==='comment'?null:n.type==='decl'?[n.type,n.prop,n.value,!!n.important]:[n.type,n.selector??n.name??'',n.params??'',(n.nodes??[]).map(structure).filter(Boolean)];
assert.deepEqual(structure(postcss.parse(css.replace(block,''))),structure(postcss.parse(baseline('app/globals.css'))),'all pre-existing CSS unchanged');
console.log('PASS C layout protection: actual factory, legacy widths/heights, new defaults, narrow fallback, saved metadata, media geometry and strictly scoped typography');
