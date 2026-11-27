import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFilmWorkflow } from "../lib/comfyui/film-workflow.ts";
import { readMp4VideoFps } from "../lib/video-fps.ts";

const original = JSON.parse(await readFile(new URL("../lib/comfyui/film-workflow.json", import.meta.url), "utf8"));
const injected = buildFilmWorkflow("frameflow-test-input.mp4");
assert.equal(original["16:9"].inputs.value, 2, "原始模板保持不变");
assert.equal(injected["4"].inputs.file,"frameflow-test-input.mp4");
assert.equal(injected["16:1"].inputs.model_name,"film_net_fp16.safetensors");
assert.equal(injected["16:9"].inputs.value,5);
assert.deepEqual(injected["ff-film-60"].inputs,{images:["16:2",0],select_every_nth:2,skip_first_images:0});
assert.deepEqual(injected["16:5"].inputs.images,["ff-film-trim",0]);
assert.equal(injected["16:5"].inputs.fps,60);
assert.deepEqual(injected["16:5"].inputs.audio,["16:3",1]);
assert.deepEqual(injected["7"].inputs.video,["16:5",0]);
for (const [fps,multiplier,every] of [[24,5,2],[25,12,5],[30,2,1],[48,5,4],[50,6,5],[60,1,1],[120,1,2]]) {
  const w=buildFilmWorkflow("input.mp4",fps);
  assert.equal(w["16:5"].inputs.fps,60);
  assert.equal(w["ff-film-60"].inputs.select_every_nth,every);
  assert.equal(fps*multiplier/every,60,"插帧与均匀取帧必须保持播放速度");
  assert.deepEqual(w["ff-film-60"].inputs.images,multiplier===1?["16:3",0]:["16:2",0]);
  const sourceFrames=fps*8;
  const resultFrames=Math.ceil(((sourceFrames-1)*multiplier+1)/every);
  assert.ok(Math.abs(resultFrames/60-8)<=1/fps+1/60,"末帧边界误差在一帧量级内");
}
assert.throws(()=>buildFilmWorkflow(""),/输入视频不可用/);
assert.throws(()=>buildFilmWorkflow("input.mp4",23.976),/整数源帧率/);
assert.throws(()=>buildFilmWorkflow("input.mp4",NaN),/整数源帧率/);

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}
function track(fps) {
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(fps * 1000, 12);
  const hdlr = Buffer.alloc(12);
  hdlr.write("vide", 8, 4, "ascii");
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(fps * 5, 8);
  stts.writeUInt32BE(1000, 12);
  return box("trak", box("mdia", Buffer.concat([box("mdhd", mdhd), box("hdlr", hdlr), box("minf", box("stbl", box("stts", stts)))])));
}
for (const fps of [24, 30, 48]) {
  const bytes = Buffer.concat([box("ftyp", Buffer.alloc(4)), box("mdat", Buffer.alloc(8)), box("moov", track(fps))]);
  assert.equal(await readMp4VideoFps(new Blob([bytes])), fps);
}
assert.equal(await readMp4VideoFps(new Blob([Buffer.alloc(10)])), null);
console.log("FILM workflow and MP4 FPS tests passed");
