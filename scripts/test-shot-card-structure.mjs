import assert from "node:assert/strict";
import { pinRelativeReferences, dependentsOf, duplicateTitles } from "../lib/shot-card-structure.ts";

const shot = (title, extra = {}) => ({ title, prompt: "p", roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "ambient", ...extra });
const queue = { version: "shot-queue-v1", title: "t", chapters: [
  { title: "a", shots: [shot("L01"), shot("L02", { generationMode: "first-last", firstFrameFrom: { shot: "previous", frame: "last" } })] },
  { title: "b", shots: [shot("L03", { generationMode: "extend", sourceShot: "previous" }), shot("L04", { generationMode: "first-last", firstFrameFrom: { shotNumber: 1, frame: "last" } })] },
] };

const pinned = pinRelativeReferences(queue);
const flat = pinned.chapters.flatMap((c) => c.shots);
assert.deepEqual(flat[1].firstFrameFrom, { shot: "L01", frame: "last" });
assert.equal(flat[2].sourceShot, "L02");
assert.deepEqual(flat[3].firstFrameFrom, { shot: "L01", frame: "last" });
// untouched shots keep their objects; original queue is not mutated
assert.deepEqual(queue.chapters[0].shots[1].firstFrameFrom, { shot: "previous", frame: "last" });

assert.deepEqual(dependentsOf(queue, "L01").sort(), ["L02", "L04"]);
assert.deepEqual(dependentsOf(queue, "L04"), []);
assert.deepEqual(duplicateTitles({ chapters: [{ shots: [shot("x"), shot("y"), shot("x")] }] }), ["x"]);

// 参考图分「场景」「角色」两组，各占一行（角色 xxx 进角色组，场景图 / 首帧 / 尾帧进场景组）。
{ const { readFileSync } = await import("node:fs"); const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
  assert.match(board, /REF_GROUPS = \[\{ id: "scene", label: "场景" \}, \{ id: "role", label: "角色" \}\]/);
  assert.match(board, /refGroupOf = \(name: string\)[^;]*name\.startsWith\("角色 "\) \? "role" : "scene"/);
  assert.match(board, /\.sc-refs\{display:flex;flex-direction:column/, "两组上下各一行"); }
console.log("shot card structure: ok");
