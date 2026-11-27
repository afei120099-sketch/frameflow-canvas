// 2026-11-12 右键「打开所在文件夹」：开发服务器接口（白名单 + explorer.exe）和画布端的路径还原。
// 只在临时文件夹里建假的 ComfyUI 目录；启动函数换成假的，不会真的打开资源管理器；不开浏览器、不碰画布数据。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  REVEAL_FILE_ROUTE, allowedRoots, comfyFilePath, comfyRoot, isInside, normalizeLocalPath,
  resolveRevealTarget, revealFile, launchExplorer, revealFileMiddleware, DEFAULT_COMFYUI_ROOT,
  LOCATE_FILE_ROUTE, LOCATE_MAX_ITEMS, locateFiles,
} from "./reveal-file-vite-plugin.mjs";
import {
  revealRequestFor, revealLocalFile, isRevealableNode, comfyHintFromRelative, NO_LOCAL_PATH,
  locateLocalFiles, guessLocalPath, LOCATE_FILE_ROUTE as CLIENT_LOCATE_ROUTE, LOCATE_MAX_ITEMS as CLIENT_LOCATE_MAX, DEFAULT_COMFYUI_ROOT as CLIENT_COMFYUI_ROOT,
} from "../lib/reveal-node-file.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "frameflow-reveal-"));
try {
  const comfy = path.join(tmp, "ComfyUI");
  const desktop = path.join(tmp, "data");
  const env = { FRAMEFLOW_COMFYUI_ROOT: comfy, FRAMEFLOW_DESKTOP_CANVAS_ROOT: desktop };
  const put = (file, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  const h3 = put(path.join(comfy, "output", "video", "Frameflow_H3_ultimate_01300-audio.mp4"), "video-bytes");
  const demix = put(path.join(comfy, "output", "video", "Frameflow_Demix_abc_00001_.mp4"));
  const frame = put(path.join(comfy, "output", "Frameflow_Frame_HD_00007_.png"));
  const deep = put(path.join(comfy, "output", "audio", "角色A", "Frameflow_Music3_00002_.mp3"));
  const uploaded = put(path.join(comfy, "input", "cover_klein_1.png"));
  const inbox = put(path.join(desktop, "inbox", "示例项目", "首帧.png"));
  const outside = put(path.join(tmp, "别处", "secret.mp4"));
  const dup1 = put(path.join(comfy, "output", "a", "same.mp4"), "1");
  const dup2 = put(path.join(comfy, "output", "b", "same.mp4"), "22");

  // ── 1. 配置：根目录不写死在调用处，能用环境变量换 ──
  assert.equal(comfyRoot({}), DEFAULT_COMFYUI_ROOT);
  assert.equal(comfyRoot(env), path.win32.normalize(comfy));
  assert.deepEqual(allowedRoots(env).map((r) => r.dir), [path.join(comfy, "output"), path.join(comfy, "input"), desktop]);
  assert.deepEqual(allowedRoots({ ...env, FRAMEFLOW_EXTRA_REVEAL_ROOTS: "C:\\extra; " }).map((r) => r.dir), [path.join(comfy, "output"), path.join(comfy, "input"), desktop, "C:\\extra"], "额外目录用环境变量加");
  assert.equal(allowedRoots({})[0].dir, "C:\\ComfyUI_windows_portable\\ComfyUI\\output");
  assert.ok(isInside("C:\\data\\a\\b.mp4", "C:\\data"));
  assert.ok(isInside("c:\\data\\b.MP4", "C:\\data\\"), "不分大小写");
  assert.ok(!isInside("C:\\data2\\b.mp4", "C:\\data"), "前缀相同的别的文件夹不算");
  assert.ok(!isInside("C:\\data", "C:\\data"), "目录本身不算文件");

  // ── 2. 路径还原：ComfyUI 记录 → 本机路径 ──
  assert.equal(comfyFilePath({ filename: "x.mp4", subfolder: "video", type: "output" }, env).path, path.join(comfy, "output", "video", "x.mp4"), "output + 子目录");
  assert.equal(comfyFilePath({ filename: "x.png", subfolder: "", type: "input" }, env).path, path.join(comfy, "input", "x.png"), "input 根目录");
  assert.equal(comfyFilePath({ filename: "x.mp3", subfolder: "audio/角色A" }, env).path, path.join(comfy, "output", "audio", "角色A", "x.mp3"), "多层子目录，type 缺省 = output");
  assert.equal(comfyFilePath({ filename: "x.mp4" }, env).path, null, "不知道子目录 → 要搜");
  assert.match(comfyFilePath({ filename: "x.png", subfolder: "", type: "temp" }, env).error, /temp.*不在允许/, "temp 不开");
  assert.match(comfyFilePath({ filename: "x.mp4", subfolder: "../../Windows" }, env).error, /子目录不对/, "子目录不能 ..");
  assert.match(comfyFilePath({ filename: "..\\x.mp4", subfolder: "" }, env).error, /文件名不对/);

  const ok = async (body, expected, message) => { const r = await resolveRevealTarget(body, { env }); assert.deepEqual(r, { ok: true, path: expected }, message); };
  await ok({ files: [{ filename: "Frameflow_H3_ultimate_01300-audio.mp4", subfolder: "video", type: "output" }] }, h3, "output/video 精确还原");
  await ok({ files: [{ filename: "Frameflow_H3_ultimate_01300-audio.mp4" }] }, h3, "只有文件名：在 output 里找到 video 子目录");
  await ok({ files: [{ filename: "Frameflow_Frame_HD_00007_.png" }] }, frame, "output 根目录的图片");
  await ok({ files: [{ filename: "Frameflow_Music3_00002_.mp3" }] }, deep, "两层子目录里的音频");
  await ok({ files: [{ filename: "cover_klein_1.png" }] }, uploaded, "output 没有就去 input 找");
  await ok({ files: [{ filename: "cover_klein_1.png", subfolder: "", type: "input" }] }, uploaded, "input 精确还原");
  await ok({ files: [{ filename: "角色A-去配乐.mp4" }, { filename: "Frameflow_Demix_abc_00001_.mp4", subfolder: "video" }] }, demix, "第一条找不到，试下一条");
  await ok({ files: [{ filename: "same.mp4" }], fileSize: 2 }, dup2, "同名多份：按大小挑");
  await ok({ path: `"${inbox}"` }, inbox, "收件箱的完整路径（带引号）");
  await ok({ path: inbox.replaceAll("\\", "/") }, inbox, "正斜杠");

  // ── 3. 拒绝：白名单外 / 不存在 / 不是本机路径 ──
  const fail = async (body, status, pattern, message) => { const r = await resolveRevealTarget(body, { env }); assert.equal(r.ok, false, message); assert.equal(r.status, status, message); assert.match(r.error, pattern, message); };
  await fail({ path: outside }, 403, /不在允许打开的目录里[\s\S]*只能打开这些目录/, "白名单外的真实文件也拒绝，并说出允许哪些目录");
  await fail({ path: "C:\\Windows\\System32\\calc.exe" }, 403, /不在允许打开的目录/, "系统文件拒绝");
  await fail({ path: path.join(comfy, "output", "..", "..", "别处", "secret.mp4") }, 403, /不在允许/, "用 .. 绕出去也拒绝");
  await fail({ path: path.join(comfy, "output", "video", "没有这个.mp4") }, 404, /文件不存在/, "白名单里但文件不存在");
  await fail({ path: path.join(comfy, "output", "video") }, 400, /不是一个文件/, "文件夹不行");
  await fail({ path: "blob:http://localhost:5173/abc" }, 400, /不是本机路径/);
  await fail({ path: "video:1234" }, 400, /不是本机路径/);
  await fail({ path: "\\\\NAS\\share\\a.mp4" }, 400, /不是本机路径（网络共享）/);
  await fail({ path: "a.mp4" }, 400, /不是本机路径/);
  await fail({ path: 'D:\\a".mp4' }, 400, /不该出现的字符/, "引号会破坏 explorer 参数，直接拒绝");
  await fail({ files: [] }, 400, new RegExp(NO_LOCAL_PATH));
  await fail({ files: [{ filename: "从没有过.mp4" }] }, 404, /本机找不到这个文件[\s\S]*找过/);
  await fail({ files: [{ filename: "x.png", type: "temp" }] }, 400, /temp/);
  try {
    const link = path.join(comfy, "output", "link.mp4");
    symlinkSync(outside, link);
    await fail({ path: link }, 403, /不在允许/, "白名单里的链接指向外面：按真实路径拒绝");
  } catch (cause) { if (cause?.code !== "EPERM") throw cause; console.log("（这台机器不允许建符号链接，跳过链接用例）"); }

  // ── 4. 启动：只开 explorer.exe，参数是数组，不走 shell ──
  const calls = [];
  const fakeRun = (file, args, options, done) => { calls.push({ file, args, options }); done(Object.assign(new Error("exit 1"), { code: 1 })); };
  assert.deepEqual(await launchExplorer(h3, fakeRun), { ok: true }, "explorer 正常也返回退出码 1，不算失败");
  assert.equal(calls[0].file, "explorer.exe", "只启动 explorer.exe");
  assert.ok(Array.isArray(calls[0].args), "参数是数组");
  assert.deepEqual(calls[0].args, [`/select,"${h3}"`], "/select 和路径在同一个参数里");
  assert.ok(!calls[0].options.shell, "不经过 shell");
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  const missing = (file, args, options, done) => done(Object.assign(new Error("spawn"), { code: "ENOENT" }));
  assert.match((await launchExplorer(h3, missing)).error, /打不开资源管理器（ENOENT）/);

  const launched = [];
  const launch = async (file) => { launched.push(file); return { ok: true }; };
  assert.deepEqual(await revealFile({ files: [{ filename: "Frameflow_H3_ultimate_01300-audio.mp4" }] }, { env, launch }), { ok: true, path: h3 });
  assert.equal((await revealFile({ path: outside }, { env, launch })).ok, false);
  assert.deepEqual(launched, [h3], "被拒绝的路径不会启动任何程序");

  // ── 5. 接口：只认本机同源画布的 POST ──
  const server = createServer((req, res) => revealFileMiddleware({ env, launch })(req, res, () => { res.writeHead(418); res.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (body, headers = { origin: base }) => fetch(base + REVEAL_FILE_ROUTE, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    let response = await post({ files: [{ filename: "Frameflow_Frame_HD_00007_.png" }] });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, path: frame });
    response = await post({ path: outside });
    assert.equal(response.status, 403); assert.match((await response.json()).error, /不在允许/);
    response = await post({ path: frame }, { origin: "http://evil.example" });
    assert.equal(response.status, 403); assert.equal((await response.json()).error, "仅限本机画布", "别的网站不能调");
    response = await post({ path: frame }, {});
    assert.equal(response.status, 403, "没有 origin 也不行");
    response = await fetch(base + REVEAL_FILE_ROUTE, { headers: { origin: base } });
    assert.equal(response.status, 405);
    response = await post("不是json");
    assert.equal(response.status, 400);
    response = await post({ path: "x".repeat(20000) });
    assert.equal(response.status, 413);
    response = await fetch(base + "/别的", { headers: { origin: base } });
    assert.equal(response.status, 418, "别的地址交给下一个中间件");
    assert.equal(launched.filter((f) => f === frame).length, 1, "只有通过检查的那次启动了");

    // ── 6. 画布端：当前显示那一版 → 请求体 ──
    const asset = (patch) => ({ schemaVersion: 1, assetId: "a1", kind: "video", origin: "generated", filename: "Frameflow_H3_ultimate_01300-audio.mp4", mimeType: "video/mp4", createdAt: 0, storageReference: "video:1", sourceRunId: "r1", ...patch });
    assert.deepEqual(revealRequestFor({ asset: asset({ fileSize: 11 }) }), { files: [{ filename: "Frameflow_H3_ultimate_01300-audio.mp4" }], fileSize: 11 }, "H3 视频：按文件名找");
    const demixRun = { musicRemoval: { status: "done", output: "video/Frameflow_Demix_abc_00001_.mp4", passes: [{ pass: 1, promptId: "p", input: "x", output: "video/Frameflow_Demix_abc_00001_.mp4" }] } };
    assert.deepEqual(revealRequestFor({ asset: asset({ filename: "Frameflow_H3_ultimate_01300-audio-去配乐.mp4", derivationType: "music_removal" }), run: demixRun }).files[0],
      { filename: "Frameflow_Demix_abc_00001_.mp4", subfolder: "video", type: "output" }, "去配乐版：用 Run 记的 output，不用画布里的名字");
    const twoPass = { musicRemoval: { status: "done", output: "video/old.mp4", passes: [{ pass: 1, output: "video/p1.mp4" }, { pass: 2, output: "video/Frameflow_Demix_x2_00001_.mp4", outputFile: { filename: "Frameflow_Demix_x2_00001_.mp4", subfolder: "video", type: "output" } }] } };
    assert.equal(revealRequestFor({ asset: asset({ derivationType: "music_removal" }), run: twoPass }).files[0].filename, "Frameflow_Demix_x2_00001_.mp4", "去配乐 ×2：最后一遍的文件");
    assert.deepEqual(revealRequestFor({ asset: asset({ filename: "audio/Frameflow_Music3_00002_.mp3", kind: "audio" }) }).files[0], { filename: "Frameflow_Music3_00002_.mp3", subfolder: "audio", type: "output" }, "带子目录的文件名");
    assert.deepEqual(revealRequestFor({ asset: null, name: "首帧.png", originalPath: inbox }), { path: inbox }, "节点记着完整路径就直接用");
    assert.deepEqual(revealRequestFor({ asset: null, name: "blob:abc", src: "blob:abc" }), null, "只有浏览器地址：没有本机路径");
    assert.deepEqual(comfyHintFromRelative("video/../x.mp4"), null);
    // 请求体送到真接口能找到文件
    const demixBody = revealRequestFor({ asset: asset({ filename: "角色A-去配乐.mp4", derivationType: "music_removal" }), run: demixRun });
    const result = await revealLocalFile(demixBody, { fetch: (url, init) => fetch(base + url, { ...init, headers: { ...init.headers, origin: base } }) });
    assert.deepEqual(result, { ok: true, path: demix }, "画布端 → 接口 → 去配乐版的真实文件");
    const imported = await revealLocalFile({ files: [{ filename: "IMG_0001.mp4" }] }, { imported: true, fetch: (url, init) => fetch(base + url, { ...init, headers: { ...init.headers, origin: base } }) });
    assert.match(imported.error, /只存在画布里，没有本机路径[\s\S]*下载媒体/, "导入的素材找不到：说只存在画布里，提示可另存");
    const generatedMissing = await revealLocalFile({ files: [{ filename: "Frameflow_H3_ultimate_09999.mp4" }] }, { fetch: (url, init) => fetch(base + url, { ...init, headers: { ...init.headers, origin: base } }) });
    assert.match(generatedMissing.error, /本机找不到/);
    const old = await revealLocalFile({ files: [{ filename: "a.mp4" }] }, { fetch: async () => new Response("Not Found", { status: 404 }) });
    assert.match(old.error, /请重启画布/, "旧服务器没有这个接口：提示重启");
    const offline = await revealLocalFile({ files: [{ filename: "a.mp4" }] }, { fetch: async () => { throw new TypeError("fetch failed"); } });
    assert.match(offline.error, /连不上开发服务器/);

    // ── 6b. 只查不开：/__file/locate（右键「复制视频清单」） ──
    assert.equal(CLIENT_LOCATE_ROUTE, LOCATE_FILE_ROUTE, "前后端接口地址一致");
    assert.equal(CLIENT_LOCATE_MAX, LOCATE_MAX_ITEMS);
    assert.equal(CLIENT_COMFYUI_ROOT, DEFAULT_COMFYUI_ROOT, "前端兜底用的 ComfyUI 根目录和插件同一个值");
    const launchedBefore = launched.length;
    const items = [
      { files: [{ filename: "Frameflow_H3_ultimate_01300-audio.mp4" }] },
      { files: [{ filename: "从没有过.mp4" }] },
      { path: frame },
      null,
      { path: outside },
      { files: [{ filename: "Frameflow_Demix_abc_00001_.mp4", subfolder: "video" }] },
    ];
    assert.deepEqual(await locateFiles({ items }, { env, launch }), { ok: true, paths: [h3, null, frame, null, null, demix] }, "多条一起查：找不到 / 没线索 / 白名单外的是 null，其他照常");
    assert.equal((await locateFiles({}, { env, launch })).status, 400);
    assert.equal((await locateFiles({ items: Array(LOCATE_MAX_ITEMS + 1).fill(null) }, { env, launch })).status, 413, "一次最多 500 条");
    const postLocate = (body, headers = { origin: base }) => fetch(base + LOCATE_FILE_ROUTE, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    response = await postLocate({ items });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, paths: [h3, null, frame, null, null, demix] }, "接口：多条一起查");
    response = await postLocate({ items: [{ files: [{ filename: "从没有过.mp4" }] }] });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, paths: [null] }, "一条找不到返回 null，不算失败");
    response = await postLocate({ items: Array.from({ length: 300 }, () => ({ files: [{ filename: "Frameflow_H3_ultimate_01300-audio.mp4" }] })) });
    assert.equal(response.status, 200, "几百条的请求体不会被当成太长"); assert.equal((await response.json()).paths.length, 300);
    response = await postLocate({ items }, { origin: "http://evil.example" });
    assert.equal(response.status, 403, "别的网站不能查");
    response = await fetch(base + LOCATE_FILE_ROUTE, { headers: { origin: base } });
    assert.equal(response.status, 405, "只接受 POST");
    assert.equal(launched.length, launchedBefore, "查路径从不启动资源管理器（launch 一次都没被调用）");

    // 画布端：locateLocalFiles 和接口一一对应；null 线索不发给服务器
    const viaServer = (url, init) => fetch(base + url, { ...init, headers: { ...init.headers, origin: base } });
    let sent = null;
    const located = await locateLocalFiles([items[0], null, items[1], items[2]], { fetch: (url, init) => { sent = JSON.parse(init.body); return viaServer(url, init); } });
    assert.deepEqual(located, { paths: [h3, null, null, frame], verified: true });
    assert.equal(sent.items.length, 3, "没线索的那条不发");
    // 旧服务器（没有这个接口，404）：纯 ComfyUI 文件名按默认根目录拼，标成没核实
    const guessed = await locateLocalFiles([
      { files: [{ filename: "Frameflow_Demix_abc_00001_.mp4", subfolder: "video", type: "output" }] },
      { files: [{ filename: "Frameflow_H3_ultimate_sample-audio.mp4" }] },
      { files: [{ filename: "x.png", subfolder: "", type: "input" }] },
      { path: "C:/data/a.mp4" },
      null,
      { files: [{ filename: "x.png", type: "temp" }] },
    ], { fetch: async () => new Response("Not Found", { status: 404 }) });
    assert.equal(guessed.verified, false);
    assert.deepEqual(guessed.paths, [
      `${DEFAULT_COMFYUI_ROOT}\\output\\video\\Frameflow_Demix_abc_00001_.mp4`,
      `${DEFAULT_COMFYUI_ROOT}\\output\\video\\Frameflow_H3_ultimate_sample-audio.mp4`,
      `${DEFAULT_COMFYUI_ROOT}\\input\\x.png`,
      "C:\\data\\a.mp4",
      null,
      null,
    ]);
    assert.equal(guessLocalPath({ files: [{ filename: "a.mp4", subfolder: "../x" }] }), null, "子目录不能 ..");
    assert.equal((await locateLocalFiles([items[0]], { fetch: async () => { throw new TypeError("fetch failed"); } })).verified, false, "连不上也不让整个操作失败");
  } finally { server.close(); }

  // ── 7. 哪些节点有这一项 ──
  assert.ok(isRevealableNode({ type: "video-node", props: { src: "video:1" } }));
  assert.ok(isRevealableNode({ type: "image-node", props: { src: "image:1" } }));
  assert.ok(isRevealableNode({ type: "audio-node", props: { src: "audio:1" } }));
  assert.ok(isRevealableNode({ type: "h3-node", props: { shotId: "s1" } }));
  assert.ok(!isRevealableNode({ type: "h3-node", props: {} }), "还没出片的 H3 节点没有");
  assert.ok(!isRevealableNode({ type: "video-node", props: { src: "" } }));
  assert.ok(!isRevealableNode({ type: "tts-node", props: { src: "audio:1" } }));
  assert.equal(normalizeLocalPath("file:///C:/%E7%A4%BA%E4%BE%8B/a.mp4").path, "C:\\示例\\a.mp4");

  console.log("reveal-file: all checks passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
