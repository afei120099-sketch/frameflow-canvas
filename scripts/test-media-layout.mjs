import assert from "node:assert/strict";
import { imageNodeSize, legacyImageNodeSize, videoNodeSize, h3PreviewSize, h3PreviewTerminal } from "../lib/media-node-layout.ts";

const imagePortrait = imageNodeSize(941, 1672);
const imageSquare = imageNodeSize(1000, 1000);
const imageLandscape = imageNodeSize(1920, 1080);
const videoPortrait = videoNodeSize(544, 960, 480);
const videoLandscape = videoNodeSize(1920, 1080, 480);

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} should be close to ${expected}`);
near(imagePortrait.w / (imagePortrait.h - 32), 941 / 1672);
near(imageSquare.w / (imageSquare.h - 32), 1);
near(imageLandscape.w / (imageLandscape.h - 32), 1920 / 1080);
near(videoPortrait.w / (videoPortrait.h - 32), 544 / 960);
near(videoLandscape.w / (videoLandscape.h - 32), 1920 / 1080);
assert.ok(videoPortrait.h <= 480 + 33, "Portrait card should fit the viewport height budget");
assert.equal(legacyImageNodeSize(941, 1672).w, 260);
assert.ok(imagePortrait.h > imagePortrait.w, "Portrait image gets a portrait card");
assert.ok(videoLandscape.w > videoLandscape.h, "Landscape video gets a landscape card");
console.log("Media node aspect ratio and viewport-fit assertions passed");
for (const [width, height] of [[1920,1080],[1080,1920],[1000,1000],[2560,1080]]) {
  const preview = h3PreviewSize(width, height);
  near(preview.w / preview.h, width / height);
  assert(preview.h <= 520 && preview.w <= 560);
}
near(h3PreviewSize(0,0).w / h3PreviewSize(0,0).h,16/9);
near(h3PreviewSize(1920,1080,760).w,760);
console.log("H3 preview: portrait, landscape, square, ultrawide, missing metadata and resized nodes passed");
for (const width of [560,760]) {
  for (const [mediaWidth,mediaHeight] of [[1080,1920],[1920,1080],[1000,1000]]) {
    const preview=h3PreviewSize(mediaWidth,mediaHeight,width);
    const left=h3PreviewTerminal(width,preview,'left');
    const right=h3PreviewTerminal(width,preview,'right');
    near(right.x-left.x,preview.w);
    near((left.x+right.x)/2,width/2);
    near(left.y,32+preview.h/2);
    near(right.y,left.y);
  }
}
const portraitTerminal=h3PreviewTerminal(560,h3PreviewSize(1080,1920),'left');
const landscapeTerminal=h3PreviewTerminal(560,h3PreviewSize(1920,1080),'left');
assert.notDeepEqual(portraitTerminal,landscapeTerminal,'media changes must move endpoints without moving the node');
console.log('PASS store-based preview terminals: aspect/width changes, no DOM or dock-height dependency');
