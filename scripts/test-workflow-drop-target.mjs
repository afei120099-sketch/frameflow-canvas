import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
import { readWorkspaceSource } from './workspace-source.mjs';
const source=readWorkspaceSource();
const block=source.slice(source.indexOf("function workflowDropTarget("),source.indexOf("function WorkflowPort("));
const js=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const a={id:"a",type:"h3-node"},b={id:"b",type:"h3-node"},arrow={id:"temp",type:"arrow"};
const shapes=[a,b,arrow], ports=[{dataset:{workflowNodeId:"b"},getBoundingClientRect:()=>({left:175,right:195,top:40,bottom:60,width:20,height:20})}];
const document={querySelectorAll:()=>ports};
const editor={
 getShape:id=>shapes.find(s=>s.id===id),screenToPage:p=>p,getCurrentPageShapes:()=>shapes,
 getShapePageBounds:s=>s.id==="a"?{x:0,y:0,w:100,h:100}:s.id==="b"?{x:200,y:0,w:100,h:100}:{x:0,y:0,w:300,h:100},
};
const resolve=new Function("document","customTypes",js+";return workflowDropTarget;")(document,new Set(["h3-node","video-node"]));
assert.equal(resolve(editor,"a",{x:185,y:50}),b,"边界外加号归属正确");
assert.equal(resolve(editor,"a",{x:250,y:50}),b,"临时连线不得遮挡目标");
assert.equal(resolve(editor,"a",{x:150,y:50}),undefined,"空白和连线不是目标");
assert.equal(resolve(editor,"b",{x:185,y:50}),undefined,"不能连自己");
assert.equal(resolve(editor,"a",{x:50,y:50}),undefined);
assert.equal((source.match(/workflowDropTarget\(editor, shape.id,/g)||[]).length,2,"悬停和松手共用识别");
assert.match(source,/data-workflow-node-id=\{shape.id\}/);
console.log("PASS outside-node ports, temporary-arrow exclusion, self/blank rejection, shared hover/drop targeting");
