// Isolated browser smoke test; uses an ephemeral Chrome profile, never the user's canvas data.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [sample, playwrightEntry, chromeExecutable] = process.argv.slice(2);
const baseUrl = process.argv[5] || "http://127.0.0.1:5173/";
if (!sample || !playwrightEntry || !chromeExecutable) throw new Error("Usage: node test-audio-canvas.mjs <voiced MP4> <playwright/index.mjs> <chrome.exe>");
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "添加素材或节点" }).waitFor();
  await page.getByRole("button", { name: "添加素材或节点" }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入视频" }).click();
  await (await chooserPromise).setFiles(sample);
  const videoNode = page.locator('.tl-shape[data-shape-type="video-node"]');
  await videoNode.waitFor();
  await videoNode.getByRole("button", { name: "提取声音" }).click();
  const panel = page.getByRole("dialog", { name: "提取声音" });
  await panel.getByText(/有音轨/).waitFor();
  await panel.getByRole("button", { name: "截取片段" }).click();
  await panel.locator(".audio-range input").nth(0).fill("1.2");
  await panel.locator(".audio-range input").nth(1).fill("3.2");
  await panel.getByRole("button", { name: "截取并创建声音节点" }).click();
  const audioNode = page.locator('.tl-shape[data-shape-type="audio-node"]');
  await audioNode.waitFor({ timeout: 30_000 });
  const audio = audioNode.locator("audio");
  await audio.waitFor();
  await page.waitForFunction(() => { const audio = document.querySelector('.tl-shape[data-shape-type="audio-node"] audio'); return audio instanceof HTMLAudioElement && audio.readyState >= 1; });
  const details = await audio.evaluate((element) => ({ duration: element.duration, src: element.src }));
  assert(Math.abs(details.duration - 2) < .05, `Expected ~2s audio, got ${details.duration}`);
  assert(details.src.startsWith("blob:"));
  await audio.click({ position: { x: 22, y: 22 } });
  await page.waitForFunction(() => document.querySelector('.tl-shape[data-shape-type="audio-node"] audio')?.paused === false);
  await audio.click({ position: { x: 22, y: 22 } });
  await page.waitForFunction(() => document.querySelector('.tl-shape[data-shape-type="audio-node"] audio')?.paused === true);

  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByPlaceholder("角色名称，例如：柴犬").fill("隔离测试角色");
  await page.getByRole("button", { name: "新建角色" }).click();
  await page.getByRole("button", { name: "关闭" }).last().click();
  await audioNode.getByRole("button", { name: "加入角色" }).click();
  const rolePanel = page.getByRole("dialog", { name: "加入角色" });
  await rolePanel.getByText("隔离测试角色").waitFor();
  await rolePanel.getByRole("button", { name: "加入", exact: true }).click();
  await rolePanel.getByText("已加入 隔离测试角色").waitFor();
  await rolePanel.getByRole("button", { name: "关闭" }).click();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.tl-shape[data-shape-type="audio-node"] audio').waitFor();
  await page.waitForFunction(() => { const audio = document.querySelector('.tl-shape[data-shape-type="audio-node"] audio'); return audio instanceof HTMLAudioElement && audio.readyState >= 1; });
  const restoredAudio = page.locator('.tl-shape[data-shape-type="audio-node"] audio');
  const restored = await restoredAudio.evaluate((element) => element.duration);
  assert(Math.abs(restored - 2) < .05);
  await restoredAudio.click({ position: { x: 22, y: 22 } });
  await page.waitForFunction(() => document.querySelector('.tl-shape[data-shape-type="audio-node"] audio')?.paused === false);
  await restoredAudio.click({ position: { x: 22, y: 22 } });
  await page.waitForFunction(() => document.querySelector('.tl-shape[data-shape-type="audio-node"] audio')?.paused === true);
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("button", { name: /隔离测试角色/ }).click();
  const library = page.getByRole("dialog", { name: "角色资产" });
  await library.getByText("主声音", { exact: true }).waitFor();
  await library.getByText(/2\.00 秒/).waitFor();
  await library.getByText(/来自视频：MiniMax_H3_i2v_00045_\.mp4/).waitFor();
  await page.getByRole("button", { name: "关闭" }).last().click();
  const asset = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("frameflow-production-records", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      return await new Promise((resolve, reject) => { const request = database.transaction("assets", "readonly").objectStore("assets").getAll(); request.onsuccess = () => resolve(request.result.find((item) => item.kind === "audio")); request.onerror = () => reject(request.error); });
    } finally { database.close(); }
  });
  assert.equal(asset.derivationType, "audio_extract");
  assert.equal(asset.sourceStartTime, 1.2);
  assert.equal(asset.sourceEndTime, 3.2);
  assert(asset.sourceVideoAssetId);
  await page.locator('.tl-shape[data-shape-type="audio-node"]').hover();
  await page.locator('.tl-shape[data-shape-type="audio-node"]').getByRole("button", { name: "删除节点" }).click();
  await page.locator('.tl-shape[data-shape-type="audio-node"]').waitFor({ state: "detached" });
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("button", { name: /隔离测试角色/ }).click();
  await page.getByRole("dialog", { name: "角色资产" }).getByText("主声音", { exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(JSON.stringify({ videoImported: true, audioNodeCreated: true, duration: details.duration, nativeControlsPlayPause: true, roleLinked: true, rolePrimaryPreserved: true, refreshPlaybackResource: restored, assetLineage: true, nodeOnlyDelete: true, pageErrors: errors.length }));
} finally {
  await browser.close();
}
