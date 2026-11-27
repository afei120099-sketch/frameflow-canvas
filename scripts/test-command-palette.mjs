import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPaletteShortcut, rankCommands, scoreText } from "../lib/command-palette.ts";

const commands = [
  { id: "new-h3", group: "创建", label: "新建 H3 节点", keywords: ["h3", "xinjian", "shengcheng", "视频"] },
  { id: "import-image", group: "创建", label: "导入图片", keywords: ["image", "tupian", "daoru"] },
  { id: "import-video", group: "创建", label: "导入视频", keywords: ["video", "shipin", "daoru"] },
  { id: "import-audio", group: "创建", label: "导入声音", keywords: ["audio", "shengyin", "daoru"] },
  { id: "open-library", group: "面板", label: "打开素材库", keywords: ["asset", "sucai", "library"] },
  { id: "open-board", group: "面板", label: "打开成片清单", keywords: ["shot", "board", "chengpian"] },
  { id: "open-errors", group: "面板", label: "打开错误中心", keywords: ["error", "log", "cuowu"] },
  { id: "zoom-fit", group: "视图", label: "适应画布", keywords: ["fit", "shiying"] },
];
const ids = (query) => rankCommands(commands, query).map((command) => command.id);

assert.deepEqual(ids(""), commands.map((command) => command.id), "empty query keeps the defined order");
assert.equal(ids("导入")[0], "import-image", "Chinese prefix");
assert.deepEqual(ids("导入").slice(0, 3), ["import-image", "import-video", "import-audio"]);
assert.equal(ids("素材")[0], "open-library", "Chinese substring");
assert.equal(ids("sucai")[0], "open-library", "pinyin alias");
assert.equal(ids("h3")[0], "new-h3");
assert.equal(ids("H3 节点")[0], "new-h3", "spaces and case are ignored");
assert.equal(ids("error")[0], "open-errors", "English alias");
assert.equal(ids("成片")[0], "open-board");
assert.equal(ids("打开清单")[0], "open-board", "subsequence match");
assert.deepEqual(ids("zzzz"), []);
assert.ok(scoreText("导入", "导入图片") > scoreText("图片", "导入图片"), "prefix beats substring");
assert.ok(scoreText("tupian", "导入图片", ["tupian"]) > scoreText("打片", "导入图片"), "keyword beats loose subsequence");

// Shortcut: Ctrl+K / Cmd+K only; plain K (tldraw laser tool) and other combos are left alone.
assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), true);
assert.equal(isPaletteShortcut({ key: "K", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }), true);
assert.equal(isPaletteShortcut({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }), false, "plain k stays tldraw's");
assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }), false);
assert.equal(isPaletteShortcut({ key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), false, "undo untouched");

// Guard: the installed tldraw does not bind Ctrl/Cmd+K (if a future version does, this fails loudly).
const tldraw = dirname(await realpath(new URL("../node_modules/tldraw", import.meta.url)));
const actions = await readFile(join(tldraw, "tldraw", "dist-esm", "lib", "ui", "context", "actions.mjs"), "utf8");
const tools = await readFile(join(tldraw, "tldraw", "dist-esm", "lib", "ui", "hooks", "useTools.mjs"), "utf8");
const bindings = [...`${actions}\n${tools}`.matchAll(/kbd: "([^"]+)"/g)].flatMap((match) => match[1].split(",").map((key) => key.trim().toLowerCase()));
assert.ok(bindings.length > 30, "tldraw shortcut table found");
for (const combo of ["cmd+k", "ctrl+k", "$k"]) assert.ok(!bindings.includes(combo), `tldraw already binds ${combo}`);
assert.ok(bindings.includes("k"), "plain k is a tldraw tool and must stay untouched");

console.log("Command palette: Chinese / pinyin / English ranking, subsequence, shortcut predicate, no conflict with the installed tldraw shortcuts passed");
