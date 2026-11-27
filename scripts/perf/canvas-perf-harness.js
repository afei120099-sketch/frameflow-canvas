// Phase 9 performance harness. Runs inside an ISOLATED browser profile only (it replaces the canvas
// through the Phase 8 restore path). Load in the dev page with:
//   const perf = await import("/scripts/perf/canvas-perf-harness.js");
//   await perf.writeFixture(500);            // backup folder with 500 mixed nodes in OPFS
//   await perf.restoreFixture();             // restores it through the real "备份" panel
//   (reload the page), then: await perf.measure()
// Nothing here touches ComfyUI or the GPU.

const TYPES = ["image-node", "video-node", "audio-node", "h3-node", "video-node", "image-node", "upscale-node", "smooth-node", "video-node", "audio-node"];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function latestBackupDir(root) {
  let latest = null;
  for await (const [name, handle] of root.entries()) if (handle.kind === "directory" && name.startsWith("frameflow-backup-") && !name.includes("zz-perf") && (!latest || name > latest.name)) latest = handle;
  if (!latest) throw new Error("先用“备份”面板导出一次（OPFS 中没有备份）");
  return latest;
}
async function readJson(dir, path) { const parts = path.split("/"); let d = dir; for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p); return JSON.parse(await (await (await d.getFileHandle(parts.at(-1))).getFile()).text()); }
async function copyTree(from, to) { for await (const [name, handle] of from.entries()) { if (handle.kind === "directory") await copyTree(handle, await to.getDirectoryHandle(name, { create: true })); else { const w = await (await to.getFileHandle(name, { create: true })).createWritable(); await w.write(await handle.getFile()); await w.close(); } } }
async function writeJson(dir, name, value) { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(JSON.stringify(value)); await w.close(); }

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const indexKey = (i) => `a1${BASE62[Math.floor(i / 3844) % 62]}${BASE62[Math.floor(i / 62) % 62]}${BASE62[i % 62]}V`;

/** Writes OPFS/frameflow-backup-zz-perf-<n>/ from the latest real backup: same records and media, n generated nodes. */
export async function writeFixture(n) {
  const root = await navigator.storage.getDirectory();
  const source = await latestBackupDir(root);
  const canvas = await readJson(source, "canvas.json");
  const records = await readJson(source, "records.json");
  const shapes = Object.values(canvas.document.store).filter((r) => r.typeName === "shape");
  const template = (type) => shapes.find((s) => s.type === type);
  const base = template("image-node") ?? shapes[0];
  const assetOf = (kind) => records.assets.find((a) => a.kind === kind && /^(image|media|audio):/.test(a.storageReference));
  const image = assetOf("image"); const video = assetOf("video"); const audio = records.assets.find((a) => a.kind === "audio" && a.storageReference.startsWith("audio:"));
  const store = Object.fromEntries(Object.entries(canvas.document.store).filter(([, r]) => r.typeName !== "shape" && r.typeName !== "binding"));
  const columns = Math.ceil(Math.sqrt(n * 1.6));
  for (let i = 0; i < n; i += 1) {
    const type = TYPES[i % TYPES.length];
    const id = `shape:perf${String(i).padStart(4, "0")}`;
    const x = (i % columns) * 460; const y = Math.floor(i / columns) * 420;
    const common = { ...base, id, type, x, y, index: indexKey(i), parentId: base.parentId, isLocked: false, opacity: 1, rotation: 0, meta: {} };
    let props;
    if (type === "image-node") props = { w: 340, h: 290, src: image.storageReference, name: `perf-${i}.png`, originalPath: `perf-${i}.png`, assetId: image.assetId };
    else if (type === "video-node") props = { w: 390, h: 300, src: video.storageReference, name: `perf-${i}.mp4`, size: "—", duration: "—", originalPath: `perf-${i}.mp4`, assetId: video.assetId, ...(i % 3 === 0 ? { origin: "smooth" } : {}) };
    else if (type === "audio-node") props = { w: 330, h: 155, src: audio.storageReference, name: `perf-${i}.wav`, duration: 1, assetId: audio.assetId, trimOpen: false };
    else if (type === "h3-node") props = { ...template("h3-node").props, collapsed: i % 2 === 0, h: i % 2 === 0 ? 132 : template("h3-node").props.h, shotId: undefined, roleIds: [], dialogueLines: [], referenceImages: [], referenceVideos: [], referenceAudios: [] };
    else if (type === "upscale-node") props = { w: 360, h: 330, clipMode: "whole", start: 0, duration: 5, collapsed: false, autoHeight: true };
    else props = { w: 360, h: 264, autoHeight: true };
    for (const key of Object.keys(props)) if (props[key] === undefined) delete props[key];
    store[id] = { ...common, props };
  }
  const dir = await root.getDirectoryHandle(`frameflow-backup-zz-perf-${String(n).padStart(4, "0")}`, { create: true });
  for await (const [name] of dir.entries()) await dir.removeEntry(name, { recursive: true });
  await copyTree(source, dir);
  await writeJson(dir, "canvas.json", { document: { ...canvas.document, store } });
  return { nodes: n, folder: dir.name, types: TYPES.length };
}

/** Restores OPFS/frameflow-backup-zz-perf-<n> through the real 备份 panel (folder input). */
export async function restoreFixture(n) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(`frameflow-backup-zz-perf-${String(n).padStart(4, "0")}`);
  const files = [];
  const walk = async (d, prefix) => { for await (const [name, h] of d.entries()) { if (h.kind === "directory") await walk(h, `${prefix}${name}/`); else { const f = await h.getFile(); Object.defineProperty(f, "webkitRelativePath", { value: `${prefix}${name}` }); files.push(f); } } };
  await walk(dir, `${dir.name}/`);
  [...document.querySelectorAll(".role-entry")].find((b) => b.textContent.includes("备份")).click();
  await wait(400);
  const input = document.querySelector(".backup-panel input[type=file]");
  const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  for (let i = 0; i < 80 && !document.querySelector(".backup-counts"); i += 1) await wait(250);
  [...document.querySelectorAll(".backup-panel button")].find((b) => b.textContent === "覆盖恢复" || b.textContent === "恢复").click();
  for (let i = 0; i < 200 && !document.querySelector(".backup-steps"); i += 1) await wait(250);
  return document.querySelector(".backup-body").textContent.slice(0, 200);
}

/** Snapshot of rendering cost right now. */
export async function measure({ interact = true } = {}) {
  const shapes = document.querySelectorAll(".tl-shape").length;
  const blobs = new Set([...document.querySelectorAll("img[src^='blob:'],video[src^='blob:'],audio[src^='blob:']")].map((el) => el.getAttribute("src")));
  const result = {
    shapes,
    domElements: document.getElementsByTagName("*").length,
    videoElements: document.querySelectorAll("video").length,
    videoElementsWithSrc: document.querySelectorAll("video[src]").length,
    audioElements: document.querySelectorAll("audio").length,
    audioElementsWithSrc: document.querySelectorAll("audio[src]").length,
    imgElements: document.querySelectorAll("img").length,
    uniqueBlobUrlsInDom: blobs.size,
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    msSinceNavigation: Math.round(performance.now()),
  };
  if (interact) {
    // Wheel-zoom and wheel-pan bursts on the canvas; long tasks (>50 ms) are the responsiveness signal.
    const longTasks = [];
    const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((e) => Math.round(e.duration))));
    try { observer.observe({ type: "longtask", buffered: false }); } catch { /* unsupported */ }
    const canvas = document.querySelector(".tl-canvas") ?? document.querySelector(".tl-container");
    const box = canvas.getBoundingClientRect();
    const started = performance.now();
    for (let i = 0; i < 30; i += 1) {
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, deltaY: i < 15 ? 60 : -60, ctrlKey: i % 2 === 0 }));
      await wait(16);
    }
    await wait(300);
    observer.disconnect();
    result.interaction = { wheelEvents: 30, elapsedMs: Math.round(performance.now() - started), longTasks: longTasks.length, longestTaskMs: longTasks.length ? Math.max(...longTasks) : 0, totalLongTaskMs: longTasks.reduce((a, b) => a + b, 0) };
    result.afterInteraction = { videoElementsWithSrc: document.querySelectorAll("video[src]").length, audioElementsWithSrc: document.querySelectorAll("audio[src]").length };
  }
  return result;
}
