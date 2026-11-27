import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOutputByContent } from "./media-trash-service.ts";
import { deleteSummary } from "../lib/safe-delete.ts";
import { TRASH_REASON } from "../lib/media-trash-policy.ts";

const root = await mkdtemp(join(tmpdir(), "delete-media-"));
try {
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const target = Buffer.from("H3 video bytes that the canvas also holds");
  const sameSizeOther = Buffer.from("H3 video bytes that the canvas also XXXX");
  await mkdir(join(root, "video", "deep"), { recursive: true });
  await writeFile(join(root, "video", "a_00001.mp4"), sameSizeOther);           // same size, different content
  await writeFile(join(root, "video", "deep", "a_00002-audio.mp4"), target);     // the real original
  await writeFile(join(root, "notes.txt"), target);                              // same bytes, not a media file

  const hit = await findOutputByContent(target.length, sha(target), root);
  assert.ok(hit.endsWith("a_00002-audio.mp4"), "found by size + SHA-256, not by name");
  assert.equal(await findOutputByContent(target.length, sha(Buffer.from("nope")), root), "", "no hash match → nothing");
  assert.equal(await findOutputByContent(0, sha(target), root), "", "empty file never matches");
  assert.equal(await findOutputByContent(target.length, sha(target), root, 1), "", "depth limit respected");

  // One readable line per delete.
  assert.equal(deleteSummary(1, { recycled: ["a"], browserCopies: [], kept: [] }), "已删除 1 个节点，1 份原文件已进 Windows 回收站。");
  assert.equal(deleteSummary(1, { recycled: ["a"], browserCopies: ["a"], kept: [] }), "已删除 1 个节点，1 份没找到磁盘原文件（只清了画布里的副本）。");
  assert.equal(deleteSummary(2, { recycled: [], browserCopies: [], kept: [{ assetId: "k" }] }), "已删除 2 个节点，1 份保留。");
  // Kept files grouped by reason: each file counted once (highest-priority reason), biggest group first.
  const kept = (n, reasons) => Array.from({ length: n }, (_, i) => ({ assetId: reasons[0] + i, reasons }));
  assert.equal(deleteSummary(14, { recycled: ["r1", "r2", "r3"], browserCopies: [], kept: [
    ...kept(6, [TRASH_REASON.pendingQueue]),
    ...kept(10, [TRASH_REASON.adopted, TRASH_REASON.pendingQueue]),
    ...kept(12, [TRASH_REASON.otherShapes, TRASH_REASON.roles]),
  ] }), "已删除 14 个节点，3 份原文件已进 Windows 回收站，28 份保留（12 份角色在用，10 份是已采用版本，6 份未完成的队列在用）。");
  assert.equal(deleteSummary(1, { recycled: [], browserCopies: [], kept: [
    { assetId: "x", reasons: ["同一生成任务还有其他素材记录，磁盘原文件可能共用，保留"] },
    { assetId: "y", reasons: [TRASH_REASON.activeRun] },
    { assetId: "z", reasons: ["将来新增的原因"] },
  ] }), "已删除 1 个节点，3 份保留（1 份未结束的生成任务在用，1 份与同任务其他素材共用原文件，1 份其他原因）。");
  assert.equal(deleteSummary(1, { recycled: [], browserCopies: [], kept: [] }), "已删除 1 个节点，这个节点没有登记生成素材，没有删除文件。");
  assert.ok(deleteSummary(1, { recycled: [], browserCopies: [], kept: [] }, "回收站助手未启动").includes("（回收站助手未启动）"));
  console.log("delete media: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
