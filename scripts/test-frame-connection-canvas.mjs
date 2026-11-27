// Ephemeral browser profile and isolated server; no ComfyUI submissions or user data changes.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const [playwrightEntry, executablePath, baseUrl = "http://127.0.0.1:5180/"] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1800, height: 1600 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const image = { mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64") };
async function importImage(name, x, y) {
  await page.mouse.dblclick(x, y);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".canvas-quick-menu").getByRole("button", { name: "导入图片", exact: true }).click();
  await (await chooser).setFiles({ ...image, name });
  await page.locator('.tl-shape[data-shape-type="image-node"]').filter({ hasText: name }).waitFor();
}
const h3 = page.locator('.tl-shape[data-shape-type="h3-node"]');
const dock = page.getByRole("region", { name: "视频创作面板" });
async function drag(name, target, offset = 0) {
  await h3.locator(".h3-preview").click();
  const node = page.locator('.tl-shape[data-shape-type="image-node"]').filter({ hasText: name });
  const nodeBox = await node.boundingBox();
  assert(nodeBox);
  await page.mouse.move(nodeBox.x + nodeBox.width - 5, nodeBox.y + nodeBox.height / 2);
  const port = await node.locator(".workflow-port:not(.workflow-input-port)").boundingBox();
  const to = await dock.locator(target).boundingBox();
  assert(port && to, "source and target must be visible");
  await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + offset, to.y + to.height / 2, { steps: 15 });
  await dock.locator(`${target}[data-magnetic="true"]`).waitFor();
  await page.mouse.up();
}
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "添加素材或节点" }).waitFor();
  await importImage("first.png", 250, 280);
  await importImage("last.png", 250, 580);
  await page.mouse.dblclick(1100, 650);
  await page.locator(".canvas-quick-menu").getByRole("button", { name: "H3 视频", exact: true }).click();
  await dock.locator(".h3-frame-slot").first().waitFor();
  await drag("first.png", '.h3-frame-slot[data-frame-role="first"]', 5);
  await dock.getByAltText("连接的首帧").waitFor();
  assert.equal(await dock.locator("[data-task-mode]").getAttribute("data-task-mode"), "i2va");
  await drag("last.png", '[data-guide-slot="0"]', 30);
  await dock.getByAltText("last.png").waitFor();
  assert.equal(await page.locator('.tl-shape[data-shape-type="arrow"]').count(), 2);
  await page.getByRole("button", { name: /撤销/ }).click(); // undo tail connection
  await dock.getByAltText("last.png").waitFor({ state: "detached" });
  await page.getByRole("button", { name: /重做/ }).click();
  await dock.getByAltText("last.png").waitFor();
  await drag("last.png", '[data-guide-slot="0"]', 5);
  await dock.getByAltText("last.png").waitFor();
  await drag("first.png", '.h3-frame-slot[data-frame-role="first"]', 60);
  await dock.getByAltText("连接的首帧").waitFor();
  await dock.locator("textarea").first().fill("连接测试：中文 English");
  assert.equal(await dock.locator("textarea").first().inputValue(), "连接测试：中文 English");
  await page.mouse.click(1600, 250);
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(400);
  await drag("first.png", '.h3-frame-slot[data-frame-role="first"]', 5);
  await dock.getByAltText("连接的首帧").waitFor();
  assert.equal(await page.locator('.tl-shape[data-shape-type="arrow"]').count(), 2, "replacement does not leave orphan lines");
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await h3.locator(".h3-preview").click();
  await dock.getByAltText("连接的首帧").waitFor();
  await dock.getByAltText("last.png").waitFor();
  assert.equal(await page.locator('.tl-shape[data-shape-type="arrow"]').count(), 2);
  assert.deepEqual(errors, []);
  console.log("PASS: mouse drop near side port and onto tail card, real frame binding, prompt editing, undo/redo, zoom, replacement and refresh persistence; no GPU");
} finally { await browser.close(); }
