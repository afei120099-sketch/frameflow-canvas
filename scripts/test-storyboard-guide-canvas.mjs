// Isolated browser data and smoke server only. Never submit a GPU job.
import assert from "node:assert/strict";
import { browserTestFixtures } from './browser-test-fixtures.mjs';
import { pathToFileURL } from "node:url";
const [playwrightEntry, executablePath, baseUrl = "http://127.0.0.1:5180/"] = process.argv.slice(2);
if (!process.argv[2] || !executablePath) throw new Error("Provide Playwright module path and browser executable, plus an isolated smoke server URL");
const fixtures = browserTestFixtures();
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1800, height: 1600 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const image = { mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64") };
const h3 = page.locator('.tl-shape[data-shape-type="h3-node"]');
const dock = page.getByRole("region", { name: "视频创作面板" });
async function importImage(name, x, y) {
  await page.mouse.dblclick(x, y);
  await page.locator(".canvas-quick-menu").getByRole("button", { name: "导入图片", exact: true }).click();
  await page.locator('input[type="file"][accept="image/jpeg,image/png,image/webp"]').last().setInputFiles({ ...image, name });
  await page.locator('.tl-shape[data-shape-type="image-node"]').filter({ hasText: name }).waitFor();
}
async function drag(name, selector) {
  await h3.locator(".h3-preview").click();
  const node = page.locator('.tl-shape[data-shape-type="image-node"]').filter({ hasText: name });
  const b = await node.boundingBox();
  await page.mouse.move(b.x + b.width - 5, b.y + b.height / 2);
  const port = await node.locator(".workflow-port:not(.workflow-input-port)").boundingBox();
  const target = await dock.locator(selector).boundingBox();
  assert(port && target);
  await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 8, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}
try {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "添加素材或节点" }).waitFor();
  await importImage("first.png", 250, 280);
  await importImage("middle.png", 250, 580);
  await page.mouse.dblclick(1000, 650);
  await page.locator(".canvas-quick-menu").getByRole("button", { name: "H3 视频", exact: true }).click();
  await dock.locator(".h3-frame-slot").first().waitFor();
  await drag("first.png", '.h3-frame-slot[data-frame-role="first"]');
  const panel = dock.getByTestId("storyboard-guides");
  const card = slot => panel.locator(`[data-guide-slot="${slot}"]`);
  assert.equal(await panel.locator(".storyboard-slot-grid > *").count(), 5);
  assert.equal(await panel.getByRole("spinbutton").count(), 0);
  assert.equal(await panel.getByRole("checkbox").count(), 0);
  for (let slot = 0; slot < 4; slot++) {
    await drag("middle.png", `[data-guide-slot="${slot}"]`);
    await card(slot).getByAltText("middle.png").waitFor();
    assert.equal(await panel.getByRole("button", { name: /^尾帧/ }).count(), 1);
    assert.equal(await dock.locator("[data-task-mode]").getAttribute("data-task-mode"), slot === 0 ? "fl2va" : "i2va", "two pictures keep native first/last; 3–5 use guide path");
  }
  assert.equal(await page.locator('.tl-shape[data-shape-type="arrow"]').count(), 5);
  const boxes = await panel.locator(".storyboard-slot-grid > *").evaluateAll(cards => cards.map(c => { const b = c.getBoundingClientRect(); return { y: b.y, h: b.height }; }));
  assert(boxes.every(b => Math.abs(b.y - boxes[0].y) < 1 && Math.abs(b.h - boxes[0].h) < 1));
  await dock.locator("textarea").first().fill("同一机位，连续动作");
  await card(3).getByRole("button", { name: /移除锚点/ }).click();
  await card(2).getByRole("button", { name: /^尾帧/ }).waitFor();
  assert.equal(await page.locator('.tl-shape[data-shape-type="arrow"]').count(), 4);
  await page.getByRole('button', {name:/撤销/}).click();
  await page.waitForFunction(() => document.querySelectorAll('.tl-shape[data-shape-type="arrow"]').length === 5, undefined, { timeout: 5000 });
  await h3.locator(".h3-preview").click();
  await card(3).getByAltText("middle.png").waitFor();
  assert.equal(await page.locator('.tl-shape[data-shape-type="arrow"]').count(), 5);
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await h3.locator(".h3-preview").click();
  await card(3).getByAltText("middle.png").waitFor();
  assert.equal(await panel.locator(".storyboard-slot-grid > *").count(), 5);
  assert.equal(await dock.locator("textarea").first().inputValue(), "同一机位，连续动作");
  await card(1).getByRole("button", { name: /^图片 3/ }).click();
  const picker = page.getByRole("dialog", { name: "选择分镜锚点图片" });
  await picker.locator('button[title="first.png"]').click();
  await picker.waitFor({ state: "hidden" });
  await card(1).getByAltText("first.png").waitFor();
  assert.equal(await page.locator('.tl-shape[data-shape-type="arrow"]').count(), 4, "picker replacement removes stale source arrow");
  await page.screenshot({ path: fixtures.screenshot('storyboard-five-slots.png') });
  assert.deepEqual(errors, []);
  console.log("PASS: fixed five equal-height slots, all four direct bindings, automatic tail, no per-picture time/end controls, prompt, remove/undo and refresh; no GPU");
} catch (cause) { await page.screenshot({ path: fixtures.screenshot('storyboard-five-failure.png') }); throw cause; }
finally { await browser.close(); fixtures.cleanup(); }
