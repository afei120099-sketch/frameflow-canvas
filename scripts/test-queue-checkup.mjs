import assert from "node:assert/strict";
import { groupQueueWarnings, checkupTotals } from "../lib/queue-checkup.ts";

const groups = groupQueueWarnings([
  "「S01-01 雨夜」检测到台词且未指定 voiceRoleId",
  "「S01-01 雨夜」体检：提示词里有否定写法",
  "「S01-02 门开」体检: 时间段没有写声音",
  "「S01-01 雨夜」体检：提示词里有否定写法",
  "没有镜头标题的一行",
  "   ",
]);
assert.deepEqual(groups.map((group) => group.title), ["S01-01 雨夜", "S01-02 门开", "整份队列"], "one group per shot, in queue order");
assert.deepEqual(groups[0].items, [
  { level: "warn", message: "检测到台词且未指定 voiceRoleId" },
  { level: "hint", message: "提示词里有否定写法" },
], "warnings first; the 体检 prefix is dropped; duplicates collapse");
assert.equal(groups[0].warn, 1);
assert.equal(groups[0].hint, 1);
assert.deepEqual(groups[1].items, [{ level: "hint", message: "时间段没有写声音" }], "half-width colon after 体检 is accepted");
assert.deepEqual(groups[2].items, [{ level: "warn", message: "没有镜头标题的一行" }]);
assert.deepEqual(checkupTotals(groups), { warn: 2, hint: 2 });
assert.deepEqual(groupQueueWarnings([]), []);
console.log("PASS queue check-up: grouped by shot, levels split, duplicates collapsed, totals");
