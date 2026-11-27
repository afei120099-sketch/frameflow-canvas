// 2026-11-12「载入路径 JSON 队列」：镜头卡片「换队列 JSON」页底部的路径输入框 + 开发服务器只读接口。
// 只在临时文件夹里建假队列；不开浏览器、不碰画布数据、不入队、不提交 GPU。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, promises as fsp } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { normalizeQueuePath, readQueueFromPath, siblingTablePath, queuePathMiddleware, QUEUE_PATH_ROUTE } from "./queue-path-vite-plugin.mjs";
import { looksLikeJsonPath, readQueuePath, loadRecentQueuePaths, rememberQueuePath, rememberTableForQueue, h3qTableKey, RECENT_QUEUE_PATHS_KEY } from "../lib/queue-path-load.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "frameflow-path-load-"));
try {
  const dir = path.join(root, "示例项目", "第三集 v5");
  mkdirSync(dir, { recursive: true });
  const queueText = JSON.stringify({ version: "shot-queue-v1", title: "示例项目 EP03", chapters: [] }, null, 2);
  const good = path.join(dir, "示例项目_EP03_v5_queue.json");
  writeFileSync(good, "\uFEFF" + queueText, "utf8");
  writeFileSync(path.join(dir, "示例项目_EP03_v5_queue_对照表.md"), "# 对照表\n", "utf8");
  const noTable = path.join(dir, "角色声音验证_又绕回原样了_v3_queue.json");
  writeFileSync(noTable, queueText, "utf8");
  const bad = path.join(dir, "写坏了_queue.json");
  writeFileSync(bad, '{"version":"shot-queue-v1","chapters":[', "utf8");
  const empty = path.join(dir, "空的_queue.json");
  writeFileSync(empty, "  \n", "utf8");
  const notJson = path.join(dir, "说明.md");
  writeFileSync(notJson, "不是队列", "utf8");
  mkdirSync(path.join(dir, "像文件夹.json"));

  // ── 1. 路径整理：引号、斜杠、中文 ──
  assert.equal(normalizeQueuePath(`"${good}"`).path, good, "Windows「复制文件地址」带的双引号去掉");
  assert.equal(normalizeQueuePath(`  '${good}'  `).path, good, "单引号、前后空格去掉");
  assert.equal(normalizeQueuePath(`“${good}”`).path, good, "中文引号也去掉");
  assert.equal(normalizeQueuePath(good.replaceAll("\\", "/")).path, good, "正斜杠认");
  assert.equal(normalizeQueuePath(good.replace(/\\/g, "\\\\")).path, good, "双反斜杠（从 JSON 里抄来的）也认");
  assert.equal(normalizeQueuePath(`"D:/a\\b/c.JSON"`).path, "D:\\a\\b\\c.JSON", "正反斜杠混用、大写 .JSON");
  const g = "C:\\下载\\示例项目\\示例项目_EP03_v5_queue.json";
  assert.equal(normalizeQueuePath(g).path, g, "中文路径原样保留");
  assert.equal(normalizeQueuePath("file:///D:/%E7%A4%BA/x.json").path, "D:\\示\\x.json", "file:/// 地址也认");
  assert.match(normalizeQueuePath("").error, /先粘贴/);
  assert.match(normalizeQueuePath('""').error, /先粘贴/, "只有引号 = 空");
  assert.match(normalizeQueuePath("示例项目_EP03_v5_queue.json").error, /完整路径/, "相对路径不收");
  assert.match(normalizeQueuePath("\\李四\\x.json").error, /完整路径/, "没盘符不收");
  assert.match(normalizeQueuePath("\\\\nas\\share\\x.json").error, /网络共享/, "网络共享路径不收");
  assert.match(normalizeQueuePath("D:\\a\\x.md").error, /只能载入 \.json/, "不是 .json 不收");
  assert.match(normalizeQueuePath("D:\\a\\x.json.txt").error, /只能载入 \.json/);
  assert.match(normalizeQueuePath("D:\\a.json\nD:\\b.json").error, /一行/, "两行不收");
  assert.match(normalizeQueuePath(42).error, /没收到路径/);
  assert.equal(siblingTablePath(good), path.join(dir, "示例项目_EP03_v5_queue_对照表.md"));

  // ── 2. 读文件：只读，出错说人话 ──
  const ok = await readQueueFromPath(`"${good.replaceAll("\\", "/")}"`);
  assert.equal(ok.ok, true);
  assert.equal(ok.text, queueText, "原文原样返回，BOM 去掉");
  assert.equal(ok.path, good);
  assert.equal(ok.tableFile, path.join(dir, "示例项目_EP03_v5_queue_对照表.md"), "旁边有同名 _对照表.md 就带上");
  assert.equal(readFileSync(good, "utf8"), "\uFEFF" + queueText, "原文件没被改动");
  const noTableResult = await readQueueFromPath(noTable);
  assert.equal(noTableResult.ok, true);
  assert.equal("tableFile" in noTableResult, false, "旁边没有对照表就不带");
  const missing = await readQueueFromPath(path.join(dir, "不存在_queue.json"));
  assert.equal(missing.ok, false); assert.equal(missing.status, 404); assert.match(missing.error, /文件不存在：.*不存在_queue\.json/);
  const missingDir = await readQueueFromPath(path.join(root, "没有这个文件夹", "x.json"));
  assert.equal(missingDir.status, 404); assert.match(missingDir.error, /文件不存在/);
  const broken = await readQueueFromPath(bad);
  assert.equal(broken.ok, false); assert.equal(broken.status, 422); assert.match(broken.error, /不是合法的 JSON/); assert.match(broken.error, /写坏了_queue\.json/);
  assert.match((await readQueueFromPath(empty)).error, /文件是空的/);
  const md = await readQueueFromPath(notJson);
  assert.equal(md.status, 400); assert.match(md.error, /只能载入 \.json/);
  assert.match((await readQueueFromPath(path.join(dir, "像文件夹.json"))).error, /文件夹/);
  const tooBig = await readQueueFromPath(good, { maxBytes: 10 });
  assert.equal(tooBig.status, 413); assert.match(tooBig.error, /文件太大/);
  // 没权限：Windows 上 chmod 只能设只读、读不受影响，所以换上假的 fs 错误码验证说法
  const realStat = fsp.stat;
  fsp.stat = async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
  try { const denied = await readQueueFromPath(good); assert.equal(denied.status, 403); assert.match(denied.error, /没有权限读这个文件/); }
  finally { fsp.stat = realStat; }

  // ── 3. 开发服务器接口：只认本机同源 POST ──
  const server = createServer((req, res) => queuePathMiddleware()(req, res, () => { res.writeHead(404); res.end("next"); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body, headers = { origin: base }) => fetch(base + QUEUE_PATH_ROUTE, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const r1 = await post({ path: `"${good}"` });
    assert.equal(r1.status, 200); const b1 = await r1.json(); assert.equal(b1.text, queueText); assert.ok(b1.tableFile.endsWith("_对照表.md"));
    assert.equal((await post({ path: good }, { origin: "https://evil.example" })).status, 403, "别的网站来源拒绝");
    assert.equal((await post({ path: good }, {})).status, 403, "没有来源拒绝");
    assert.equal((await fetch(base + QUEUE_PATH_ROUTE, { headers: { origin: base } })).status, 405, "GET 不收");
    assert.equal((await post("不是 json")).status, 400);
    const r404 = await post({ path: path.join(dir, "不存在_queue.json") }); assert.equal(r404.status, 404); assert.match((await r404.json()).error, /文件不存在/);
    const r422 = await post({ path: bad }); assert.equal(r422.status, 422); assert.match((await r422.json()).error, /不是合法的 JSON/);
    assert.equal((await post({ path: notJson })).status, 400);
    assert.equal((await post({ path: "D:\\" + "很长".repeat(3000) + ".json" })).status, 413, "请求体上限");
    assert.equal(await (await fetch(base + "/别的路径")).text(), "next", "别的路径放过");

    // ── 4. 画布这头：读接口、最近 5 条、对照表 ──
    const via = (url, init) => fetch(base + url, { ...init, headers: { ...init.headers, origin: base } });
    const c1 = await readQueuePath(`"${good.replaceAll("\\", "/")}"`, via);
    assert.equal(c1.ok, true); assert.equal(c1.text, queueText); assert.equal(c1.path, good); assert.ok(c1.tableFile);
    const c2 = await readQueuePath(bad, via);
    assert.equal(c2.ok, false); assert.match(c2.error, /不是合法的 JSON/);
    assert.match((await readQueuePath(good, async () => new Response("Not Found", { status: 404 }))).error, /重启画布/, "旧开发服务器没这个接口：提示重启");
    assert.match((await readQueuePath(good, async () => { throw new TypeError("fetch failed"); })).error, /连不上开发服务器/);
  } finally { server.close(); }

  assert.equal(looksLikeJsonPath(`"${good}"`), true);
  assert.equal(looksLikeJsonPath("D:/a/b.json"), true);
  assert.equal(looksLikeJsonPath('{"version":"shot-queue-v1"}'), false, "粘贴 JSON 正文不当路径");
  assert.equal(looksLikeJsonPath("D:\\a\\b.md"), false);

  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const store = mem();
  for (const n of [1, 2, 3, 4, 5, 6]) rememberQueuePath(`D:\\q\\${n}.json`, store);
  assert.deepEqual(loadRecentQueuePaths(store), ["D:\\q\\6.json", "D:\\q\\5.json", "D:\\q\\4.json", "D:\\q\\3.json", "D:\\q\\2.json"], "最多 5 条，新的在前");
  rememberQueuePath("d:\\Q\\3.JSON", store);
  assert.equal(loadRecentQueuePaths(store)[0], "d:\\Q\\3.JSON"); assert.equal(loadRecentQueuePaths(store).length, 5, "同一路径不分大小写只留一条");
  store.setItem(RECENT_QUEUE_PATHS_KEY, "坏的");
  assert.deepEqual(loadRecentQueuePaths(store), [], "存的东西坏了不报错");
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadRecentQueuePaths(throwing), []);
  assert.deepEqual(rememberQueuePath("D:\\x.json", throwing), ["D:\\x.json"], "浏览器存储被禁也不报错");
  assert.deepEqual(loadRecentQueuePaths(null), []);

  const tables = mem(), key = h3qTableKey("示例项目 EP03");
  tables.setItem(key, "C:\\旧\\EP03_v4_queue_对照表.md");
  const undo = rememberTableForQueue(queueText, "C:\\新\\EP03_v5_queue_对照表.md", tables);
  assert.equal(tables.getItem(key), "C:\\新\\EP03_v5_queue_对照表.md", "按标题记成这份队列的 h3q 对照表");
  undo();
  assert.equal(tables.getItem(key), "C:\\旧\\EP03_v4_queue_对照表.md", "载入没成功：恢复原来的");
  rememberTableForQueue(queueText, undefined, tables);
  assert.equal(tables.getItem(key), null, "旁边没有对照表：清掉旧的，免得沿用别的版本");
  rememberTableForQueue("{坏", "x", tables)(); rememberTableForQueue(queueText, "x", throwing)();

  // ── 5. 界面接线（读源码）──
  const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const input = board.slice(board.indexOf("function QueueInput("), board.indexOf("function EmptyCards("));
  const actions = input.slice(input.indexOf('<div className="sc-intake-actions">'));
  assert.ok(actions.indexOf('aria-label="载入路径 JSON 队列"') > 0 && actions.indexOf('aria-label="载入路径 JSON 队列"') < actions.indexOf("载入 JSON 文件<input"), "路径框在「载入 JSON 文件」左边");
  assert.match(input, /placeholder=\{pathBusy \? "正在读取…" : "粘贴 JSON 文件路径，回车载入"\}/);
  assert.match(input, /event\.key === "Enter"\) \{ event\.preventDefault\(\); void loadPath\(\); \}/, "回车载入");
  assert.match(input, /if \(event\.nativeEvent\.isComposing\) return;/, "输入法选字时回车不载入");
  assert.match(input, /if \(!looksLikeJsonPath\(pasted\)\) return;/, "粘贴像路径才自动载入");
  assert.match(input, /setText\(result\.text\);\n    const undoTable = rememberTableForQueue\(result\.text, result\.tableFile\);\n    const problem = await Promise\.resolve\(onLoad\(result\.text\)\)/, "和载入文件一样：填进文本框，交给同一个 onLoad（照常检查、照常确认换队列）");
  assert.match(input, /if \(problem\) \{ undoTable\(\); setError\(problem\); \}/);
  assert.match(input, /result\.size > 1_500_000\) \{ setPathBusy\(false\); setError\("文件太大，不像镜头表"\)/, "大小上限和「载入 JSON 文件」一样");
  assert.doesNotMatch(input.slice(input.indexOf("const loadPath"), input.indexOf("useEffect(")), /enqueue|runShot|comfy/i, "按路径载入不入队");
  assert.match(input, /onFocus=\{\(\) => setRecentOpen\(true\)\}/, "获得焦点就下拉最近用过的");
  assert.match(board, /\.sc-path>\.sc-input\{height:100%/, "和旁边按钮一样高");
  assert.doesNotMatch(board.slice(board.indexOf(".sc-path{"), board.indexOf(".sc-path-recent button:hover")), /#[0-9a-f]{3,6}\b|purple|violet/i, "只用灰度变量，不带紫色");
  assert.ok(board.includes("const tableKey = `frameflow.shotCard.h3qTable.v1|${queue.title}`;"), "卡片对照表键和 h3qTableKey 是同一个");
  assert.equal(h3qTableKey("T"), "frameflow.shotCard.h3qTable.v1|T");
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /queuePathPlugin\(\)/, "开发服务器装上接口");
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("test:queue-path-load 通过");
