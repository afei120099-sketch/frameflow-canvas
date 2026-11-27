import assert from "node:assert/strict";
import { workflowCurve } from "../lib/workflow-curve.ts";
for (const [a,b] of [[{x:0,y:0},{x:400,y:300}],[{x:50,y:300},{x:0,y:0}],[{x:0,y:0},{x:1,y:0}],[{x:0,y:0},{x:0,y:800}]]) {
  const curve = workflowCurve(a,b);
  assert.deepEqual(curve.points[0], a);
  assert.deepEqual(curve.points.at(-1), b);
  assert.match(curve.path,/ C/);
  assert(curve.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.equal(curve.points.length,49);
}
console.log("PASS: workflow S-curve endpoints, sampled hit geometry, backward/short/vertical links");
