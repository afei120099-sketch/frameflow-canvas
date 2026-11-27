// 按画布页单独导出：审片标记只带这一页素材的那几条；合并回去不覆盖本机已有的。
import assert from "node:assert/strict";
import { scopeProjectToPage } from "../lib/project-backup.ts";
import { DIRECTOR_STAGE_DATABASE } from "../lib/director-stage/store.ts";

const entry = (assetId) => ({ assetId, tags: ["face"], queueTitle: "q", shotTitle: "L01", updatedAt: 1 });
const project = {
  media: { images: [], videos: [], audios: [] },
  records: {
    assets: [{ assetId: "a1", canvasPageIds: ["page:p1"] }, { assetId: "a2", canvasPageIds: ["page:p2"] }],
    runs: [], shots: [], roles: [],
    meta: [{ key: "review-tags-v1", value: { a1: entry("a1"), a2: entry("a2") } }, { key: "nextShotNumber", value: 5 }],
  },
  director: Object.fromEntries(DIRECTOR_STAGE_DATABASE.stores.map(([store]) => [store, []])),
};
const doc = { store: { "page:p1": { id: "page:p1", typeName: "page", name: "P1" }, "page:p2": { id: "page:p2", typeName: "page", name: "P2" } } };
const scoped = scopeProjectToPage(project, doc, "page:p1");
const row = scoped.project.records.meta.find((item) => item.key === "review-tags-v1");
assert.ok(row, "审片标记跟着页面导出");
assert.deepEqual(Object.keys(row.value), ["a1"], "只带这一页素材的标记");
assert.equal(scoped.project.records.meta.some((item) => item.key === "nextShotNumber"), false, "别的 meta 仍不带");
const none = scopeProjectToPage({ ...project, records: { ...project.records, meta: [{ key: "review-tags-v1", value: { a2: entry("a2") } }] } }, doc, "page:p1");
assert.equal(none.project.records.meta.length, 0, "这一页没有标记就不带空行");
console.log("page review tags: 按页导出带上本页审片标记; ok");
