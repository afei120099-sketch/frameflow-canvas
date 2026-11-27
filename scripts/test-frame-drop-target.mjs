import assert from "node:assert/strict";
import { nearestFrameDropTarget } from "../lib/frame-drop-target.ts";
const box = (role, left, top, width, height) => ({ role, bounds: { left, top, right: left + width, bottom: top + height } });
const first = box("first", 100, 100, 200, 60);
const last = box("last", 310, 100, 200, 60);
assert.equal(nearestFrameDropTarget({ x: 60, y: 130 }, [first, last]), first);
assert.equal(nearestFrameDropTarget({ x: 320, y: 130 }, [first, last]), last, "inside tail beats nearby first");
assert.equal(nearestFrameDropTarget({ x: 306, y: 130 }, [first, last]), last, "closest target, not DOM order");
assert.equal(nearestFrameDropTarget({ x: 57, y: 130 }, [first]), null);
for (const zoom of [.35, .7, 1, 2]) {
  const port = box("last", 100 * zoom, 250 * zoom, 25 * zoom, 20 * zoom);
  assert.equal(nearestFrameDropTarget({ x: port.bounds.left - 40, y: (port.bounds.top + port.bounds.bottom) / 2 }, [port]), port);
}
assert.equal(nearestFrameDropTarget({ x: 0, y: 0 }, [box("hidden", 0, 0, 0, 0)]), null);
console.log("PASS: full cards, side ports, nearest role, 42px tolerance and zoom-independent hit testing");
