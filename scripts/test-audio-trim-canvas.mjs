// Phase 4.1 end-to-end smoke in an ephemeral browser context; no user canvas data is touched.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [sample, playwrightEntry, chromeExecutable] = process.argv.slice(2);
const baseUrl = process.argv[5] || "http://127.0.0.1:5173/";
if (!sample || !playwrightEntry || !chromeExecutable) throw new Error("Usage: node test-audio-trim-canvas.mjs <voiced MP4> <playwright/index.mjs> <chrome.exe>");
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 2560, height: 1440 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

async function dragHandle(node, side, seconds, duration = 8) {
  const track = await node.locator(".audio-waveform-track").boundingBox();
  const handle = await node.getByRole("button", { name: side === "start" ? "拖动开始时间" : "拖动结束时间" }).boundingBox();
  assert(track && handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * seconds / duration, track.y + track.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function assets() {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("frameflow-production-records", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise((resolve, reject) => { const request = database.transaction("assets", "readonly").objectStore("assets").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { database.close(); }
  });
}

async function roles() {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("frameflow-role-records", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise((resolve, reject) => { const request = database.transaction("roles", "readonly").objectStore("roles").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { database.close(); }
  });
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "添加素材或节点" }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入视频" }).click();
  await (await chooserPromise).setFiles(sample);
  const video = page.locator('.tl-shape[data-shape-type="video-node"]');
  await video.waitFor();
  await video.getByRole("button", { name: "提取声音" }).click();
  const extract = page.getByRole("dialog", { name: "提取声音" });
  await extract.getByText(/有音轨/).waitFor();
  await extract.getByRole("button", { name: "提取整段声音" }).click();

  const nodes = page.locator('.tl-shape[data-shape-type="audio-node"]');
  await nodes.first().waitFor({ timeout: 30_000 });
  const originalId = await nodes.first().getAttribute("data-shape-id");
  assert(originalId);
  const original = page.locator(`.tl-shape[data-shape-id="${originalId}"]`);
  await page.waitForFunction(() => { const audio = document.querySelector('.tl-shape[data-shape-type="audio-node"] audio'); return audio instanceof HTMLAudioElement && audio.readyState >= 1; });
  assert(Math.abs(await original.locator("audio").evaluate((audio) => audio.duration) - 8) < .05);

  await original.getByRole("button", { name: "裁剪声音" }).click();
  await original.locator('[data-waveform-ready="true"]').waitFor({ timeout: 20_000 });
  const waveform = await original.locator("canvas").evaluate((canvas) => { const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; let occupied = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) occupied++; return { occupied, total: pixels.length / 4 }; });
  assert(waveform.occupied > 100 && waveform.occupied < waveform.total);
  await dragHandle(original, "start", 1);
  await dragHandle(original, "end", 3);
  await original.getByText("开始 00:01.00").waitFor();
  await original.getByText("结束 00:03.00").waitFor();
  await original.getByText("选区 00:02.00").waitFor();
  await original.getByRole("button", { name: "▶ 试听选区" }).click();
  await page.waitForFunction((id) => document.querySelector(`.tl-shape[data-shape-id="${id}"] audio`)?.paused === false, originalId);
  await page.waitForFunction((id) => { const audio = document.querySelector(`.tl-shape[data-shape-id="${id}"] audio`); return audio?.paused === true && Math.abs(audio.currentTime - 3) < .08; }, originalId, { timeout: 6_000 });
  await original.getByRole("button", { name: "裁剪为新声音" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tl-shape[data-shape-type="audio-node"]').length === 2);
  await dragHandle(original, "end", 5);
  await dragHandle(original, "start", 3);
  await original.getByText("选区 00:02.00").waitFor();
  await original.getByRole("button", { name: "裁剪为新声音" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tl-shape[data-shape-type="audio-node"]').length === 3);

  const records = (await assets()).filter((asset) => asset.kind === "audio");
  const full = records.find((asset) => asset.derivationType === "audio_extract");
  const clips = records.filter((asset) => asset.derivationType === "audio_clip").sort((a, b) => a.sourceStartTime - b.sourceStartTime);
  assert(full && clips.length === 2);
  assert.equal(clips[0].sourceAudioAssetId, full.assetId);
  assert.equal(clips[1].sourceAudioAssetId, full.assetId);
  assert.equal(clips[0].sourceVideoAssetId, undefined);
  assert.equal(clips[0].sourceStartTime, 1);
  assert.equal(clips[0].sourceEndTime, 3);
  assert.equal(clips[1].sourceStartTime, 3);
  assert.equal(clips[1].sourceEndTime, 5);
  assert.notEqual(clips[0].storageReference, clips[1].storageReference);
  assert(Math.abs(clips[0].duration - 2) < .05 && Math.abs(clips[1].duration - 2) < .05);
  const firstClip = page.locator('.tl-shape[data-shape-type="audio-node"]').filter({ has: page.locator(`[title="${clips[0].filename}"]`) });
  await firstClip.waitFor();
  const downloadPromise = page.waitForEvent("download");
  await firstClip.hover();
  await firstClip.getByRole("button", { name: "下载媒体" }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), clips[0].filename);

  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByPlaceholder("角色名称，例如：柴犬").fill("隔离测试角色");
  await page.getByRole("button", { name: "新建角色" }).click();
  await page.getByRole("button", { name: "关闭" }).last().click();
  await original.getByRole("button", { name: "加入角色" }).click();
  await page.getByRole("dialog", { name: "加入角色" }).getByRole("button", { name: "加入", exact: true }).click();
  await page.getByRole("dialog", { name: "加入角色" }).getByText("已加入 隔离测试角色").waitFor();
  assert.equal((await roles())[0].primaryVoiceAssetId, full.assetId);
  await page.getByRole("dialog", { name: "加入角色" }).getByRole("button", { name: "关闭" }).click();
  await firstClip.getByRole("button", { name: "加入角色" }).click();
  const rolePanel = page.getByRole("dialog", { name: "加入角色" });
  await rolePanel.getByRole("button", { name: "加入", exact: true }).click();
  await rolePanel.getByText("已加入 隔离测试角色").waitFor();
  assert.equal((await roles())[0].primaryVoiceAssetId, full.assetId);
  page.once("dialog", (dialog) => dialog.accept());
  await rolePanel.getByRole("button", { name: "设为主声音" }).click();
  await rolePanel.getByText("已设为 隔离测试角色 的主声音").waitFor();
  assert.equal((await roles())[0].primaryVoiceAssetId, clips[0].assetId);
  await rolePanel.getByRole("button", { name: "关闭" }).click();

  await dragHandle(original, "start", 7.9);
  const shortest = await original.getByText(/选区 00:00\./).innerText();
  assert(shortest.includes("00:00.20"));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll('.tl-shape[data-shape-type="audio-node"]').length === 3);
  await page.waitForFunction(() => [...document.querySelectorAll('.tl-shape[data-shape-type="audio-node"] audio')].every((audio) => audio.readyState >= 1));
  const restored = await page.locator('.tl-shape[data-shape-type="audio-node"] audio').evaluateAll((audios) => audios.map((audio) => audio.duration).sort((a, b) => a - b));
  assert(Math.abs(restored[0] - 2) < .05 && Math.abs(restored[1] - 2) < .05 && Math.abs(restored[2] - 8) < .05);
  const restoredFirstClip = page.locator('.tl-shape[data-shape-type="audio-node"]').filter({ has: page.locator(`[title="${clips[0].filename}"]`) });
  await restoredFirstClip.locator("audio").evaluate(async (audio) => { await audio.play(); if (audio.paused) throw new Error("Restored clip cannot play"); audio.pause(); });
  assert.equal((await roles())[0].primaryVoiceAssetId, clips[0].assetId);
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("button", { name: /隔离测试角色/ }).click();
  await page.getByRole("dialog", { name: "角色资产" }).getByText("主声音", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭" }).last().click();
  const restoredClip = page.locator('.tl-shape[data-shape-type="audio-node"]').filter({ has: page.locator(`[title="${clips[0].filename}"]`) });
  await restoredClip.hover();
  await restoredClip.getByRole("button", { name: "删除节点" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tl-shape[data-shape-type="audio-node"]').length === 2);
  assert((await assets()).some((asset) => asset.assetId === clips[0].assetId));
  assert.equal((await roles())[0].primaryVoiceAssetId, clips[0].assetId);
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("button", { name: /隔离测试角色/ }).click();
  await page.getByRole("dialog", { name: "角色资产" }).getByText("主声音", { exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(JSON.stringify({ fullSeconds: full.duration, clippedSeconds: clips.map((clip) => clip.duration), waveformPixels: waveform.occupied, dragSelection: true, previewAutoStop: true, download: download.suggestedFilename(), roleLinked: true, refreshRestored: restored, nodeOnlyDelete: true, pageErrors: errors.length }));
} finally {
  await browser.close();
}
