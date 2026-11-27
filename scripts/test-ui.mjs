import assert from "node:assert/strict";
import { connectedChain, directLinks, feedingLinks, getGeneratingSnapshot, linkStyleRules, setNodeGenerating, subscribeGenerating } from "../lib/link-highlight.ts";
import { toastTone } from "../lib/ui-tone.ts";

// img → h3 → video → upscale → hd ; separate: img2 → h3b
const links = [
  { id: "a1", from: "img", to: "h3" }, { id: "a2", from: "h3", to: "video" }, { id: "a3", from: "video", to: "upscale" }, { id: "a4", from: "upscale", to: "hd" },
  { id: "b1", from: "img2", to: "h3b" },
];

// Selected chain = whole connected component, as the previous overlay did.
assert.deepEqual([...connectedChain("video", links)].sort(), ["a1", "a2", "a3", "a4"]);
assert.deepEqual([...connectedChain("h3b", links)], ["b1"]);
assert.deepEqual([...connectedChain("lonely", links)], []);
assert.deepEqual([...directLinks("video", links)].sort(), ["a2", "a3"]);
assert.deepEqual([...feedingLinks(new Set(["upscale", "h3b"]), links)].sort(), ["a3", "b1"]);

// Idle links recede; only directly relevant edges gain full emphasis.
assert.match(linkStyleRules({ links, zoom: 1 }), /opacity:\.48/);

// Selected: others recede, chain emphasised, no motion.
{
  const css = linkStyleRules({ links, selectedId: "h3", zoom: 1 });
  assert.match(css, /\.tl-shape\[data-shape-type="arrow"\]\{opacity:\.26\}/);
  for (const id of ["a1", "a2"]) assert.match(css, new RegExp(`data-shape-id="${id}"\\]\\{opacity:\\.95`));
  for (const id of ["a3", "a4"]) assert.match(css, new RegExp(`data-shape-id="${id}"\\]\\{opacity:\\.5`));
  assert.doesNotMatch(css, /data-shape-id="b1"/);
  assert.doesNotMatch(css, /animation/, "selection alone never animates");
}

// Hover: only the hovered node's direct links brighten; no motion.
{
  const css = linkStyleRules({ links, hoveredId: "h3b", zoom: 1 });
  assert.match(css, /data-shape-id="b1"\]\{opacity:\.9/);
  assert.doesNotMatch(css, /data-shape-id="a1"/);
  assert.doesNotMatch(css, /animation/);
  assert.equal(linkStyleRules({ links, selectedId: "h3", hoveredId: "h3", zoom: 1 }), linkStyleRules({ links, selectedId: "h3", zoom: 1 }), "hovering the selected node adds nothing");
}

// Generating: links feeding the generating node flow slowly at mid/near zoom; static when far or reduced motion.
{
  const flowing = linkStyleRules({ links, generatingIds: new Set(["upscale"]), zoom: 1 });
  assert.match(flowing, /data-shape-id="a3"\] g\[style\*="clip-path"\]>path\{stroke-dasharray:7 9;animation:ff-link-flow 1\.6s linear infinite\}/);
  assert.doesNotMatch(flowing, /data-shape-id="a4"\] g\[style/, "only the feeding link moves");
  assert.equal((flowing.match(/animation/g) ?? []).length, 1);
  const far = linkStyleRules({ links, generatingIds: new Set(["upscale"]), zoom: 0.3 });
  assert.doesNotMatch(far, /animation/, "far zoom is static");
  assert.match(far, /data-shape-id="a3"\]\{opacity:1/, "but still marked");
  assert.doesNotMatch(linkStyleRules({ links, generatingIds: new Set(["upscale"]), zoom: 1, reducedMotion: true }), /animation/);
}

// Ids are escaped inside attribute selectors.
assert.match(linkStyleRules({ links: [{ id: 'x"y', from: "n", to: "m" }], selectedId: "n", zoom: 1 }), /data-shape-id="x\\"y"/);

// 500-node canvas: rule generation stays far below one frame.
{
  const nodes = Array.from({ length: 500 }, (_, i) => `shape:n${i}`);
  const big = nodes.slice(1).map((node, i) => ({ id: `shape:l${i}`, from: nodes[Math.floor(i / 2)], to: node }));
  const generating = new Set(nodes.filter((_, i) => i % 50 === 0));
  const started = performance.now();
  let css = "";
  for (let round = 0; round < 50; round += 1) css = linkStyleRules({ links: big, selectedId: nodes[round % 20], hoveredId: nodes[(round * 7) % 500], generatingIds: generating, zoom: 1 });
  const perPass = (performance.now() - started) / 50;
  assert.ok(perPass < 8, `500 nodes / 499 links: ${perPass.toFixed(2)} ms per overlay pass`);
  assert.ok((css.match(/animation/g) ?? []).length <= generating.size, "at most one flowing link per generating node here");
  console.log(`  link overlay 500 nodes: ${perPass.toFixed(2)} ms per pass, ${css.length} chars`);
}

// Generating-state store: publish/unpublish is idempotent and notifies subscribers once per change.
{
  let calls = 0;
  const off = subscribeGenerating(() => { calls += 1; });
  setNodeGenerating("shape:b", true); setNodeGenerating("shape:a", true); setNodeGenerating("shape:a", true);
  assert.equal(getGeneratingSnapshot(), "shape:a,shape:b");
  setNodeGenerating("shape:a", false); setNodeGenerating("shape:zzz", false);
  assert.equal(getGeneratingSnapshot(), "shape:b");
  assert.equal(calls, 3);
  off(); setNodeGenerating("shape:b", false);
  assert.equal(calls, 3, "unsubscribed");
}

// Toast tones.
assert.equal(toastTone("H3 视频已生成并加入画布"), "success");
assert.equal(toastTone("高清增强失败"), "error");
assert.equal(toastTone("显存不足：请降低时长"), "error");
assert.equal(toastTone("ComfyUI 未连接，任务状态待确认"), "warning");
assert.equal(toastTone("请先连接一个视频节点"), "warning");
assert.equal(toastTone("文本工具已启用，在画布上点击输入"), "info");

console.log("UI V1: link chain / hover / generating flow (static when far or reduced motion), 500-node overlay cost, generating store, toast tones passed");
