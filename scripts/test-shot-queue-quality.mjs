import assert from "node:assert/strict";
import {parseShotQueue, shotQueueExample, shotQueueMegapixels, shotQueueH3Props} from "../lib/shot-queue.ts";
import {newQueueSession} from "../lib/shot-queue-session.ts";
import {planH3Submission} from "../lib/comfyui/h3-adapter.ts";
const sample = shotQueueExample();
const rawShot = sample.chapters[0].shots[0];
const plan = {scenes:[{src:"scene.png",name:"scene.png",assetId:"scene"}],appearances:[],pictures:[]};
const parse = (defaults, quality = {}) => parseShotQueue(JSON.stringify({
  ...sample, ...(defaults === undefined ? {} : {defaults}),
  chapters:[{...sample.chapters[0],shots:[{...rawShot,...quality}]}],
}));
const budget = (defaults, quality) => {
  const queue = parse(defaults,quality), shot = queue.chapters[0].shots[0];
  return shotQueueH3Props(shot,plan,queue.defaults).megapixels;
};
assert.equal(budget(undefined),.5, "旧 JSON 默认值不变");
assert.equal(budget({resolution:"720p"}),.87890625);
assert.equal(budget({resolution:"480p"}),.390625);
assert.equal(budget({resolution:"720p"},{megapixels:.88}),.88);
assert.equal(budget({megapixels:.8},{resolution:"480p"}),.390625,"镜头级优先于默认值");
assert.equal(budget({resolution:"720p",megapixels:.6}),.6,"同级预算优先");
assert.equal(budget({resolution:"720p"},{resolution:"480p",megapixels:.7}),.7);
for (const aspect of ["16:9","9:16","1:1","4:3","3:4"]) {
  const q = parse({resolution:"720p"},{aspect});
  const shot = q.chapters[0].shots[0];
  const value = shotQueueMegapixels(shot,q.defaults);
  assert.ok(value >= .3 && value <= 1);
}
for (const value of [.3,1]) assert.equal(budget(undefined,{megapixels:value}),value);
for (const value of [.29,1.01,"0.88",null,true]) {
  assert.throws(()=>parse(undefined,{megapixels:value}),/megapixels/);
  assert.throws(()=>parse({megapixels:value}),/megapixels/);
}
for (const resolution of ["1080p","720P",720,null]) assert.throws(()=>parse({resolution}),/resolution/);
for (const defaults of [null,[],3,"720p"]) assert.throws(()=>parse(defaults),/defaults/);
const q = parse({resolution:"720p"},{megapixels:.88});
assert.deepEqual(parseShotQueue(JSON.stringify(q)),q,"重新导入保留画质字段");
const session = newQueueSession("page:quality",q,{x:0,y:0});
assert.equal(session.queue.defaults.resolution,"720p");
assert.equal(session.queue.chapters[0].shots[0].megapixels,.88);
const props = shotQueueH3Props(q.chapters[0].shots[0],plan,q.defaults);
const result = planH3Submission({
  workflowOptionId:props.workflowOptionId,taskMode:"ref2va",prompt:props.prompt,seed:1,
  settings:{length:141,aspect:props.mode,megapixels:props.megapixels,turbo:true,steps:10,fps:24,loraStrength:.75,upscaleMethod:"lanczos",resolutionSteps:32,soundMode:props.soundMode},
},{references:{images:["scene.png","actor.png"],videos:[],audios:[]}});
assert.equal(result.workflow["115"].inputs.megapixels,.88,"真实工作流获得队列预算");
assert.equal(props.prompt,rawShot.prompt);
assert.deepEqual(props.roleIds,rawShot.roleIds);
console.log("PASS queue quality defaults, per-shot overrides, aspect conversion, strict validation, old JSON, session/JSON roundtrip, actual H3 workflow budget");
