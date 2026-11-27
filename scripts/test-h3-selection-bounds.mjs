import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Rectangle2d } from 'tldraw';
import { h3PreviewSize } from '../lib/media-node-layout.ts';
const source = readFileSync(new URL('../app/canvas-workspace.tsx', import.meta.url), 'utf8');
const body = source.match(/override getGeometry\(shape: H3Node\) \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(body, 'H3 supplies media-only geometry');
const geometry = new Function('shape', 'Rectangle2d', 'h3PreviewSize', body);
for (const previewHeight of [315, 520]) {
  const shape = { props: { w: 560, h: 1200, previewHeight } };
  const bounds = geometry(shape, Rectangle2d, h3PreviewSize).bounds;
  assert.equal(bounds.height, 32 + previewHeight);
  assert.equal(bounds.width, 560);
  assert.equal(bounds.containsPoint({x:280,y:32+previewHeight/2}), true, 'media can be selected');
  assert.equal(bounds.containsPoint({x:280,y:32+previewHeight+100}), false, 'hidden composer cannot be selected');
  assert.equal(shape.props.h, 1200, 'saved layout remains unchanged');
}
assert.equal(geometry({props:{w:560,h:1200}},Rectangle2d,h3PreviewSize).bounds.height,347);
console.log('PASS H3 selection excludes hidden composer, portrait/landscape/fallback, saved dimensions preserved');
process.exit(0); // tldraw's browser-oriented scheduler otherwise keeps Node alive.
