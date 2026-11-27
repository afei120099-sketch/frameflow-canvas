import assert from "node:assert/strict";
import { databases } from "./fake-indexeddb.mjs";
import { DAILY_BACKUP_KEEP, dailyBackupFiles, daysToPrune, listDailyBackups, localDay, readDailyBackup, runDailyBackup } from "../lib/daily-backup.ts";
import { ensurePersistentStorage, isPersistent, persistenceLabel } from "../lib/storage-persistence.ts";
import { LIGHT_BACKUP_NOTE, collectProject, restoreProject } from "../lib/project-backup.ts";
import { storeLocalImage } from "../lib/local-video-store.ts";
import { createShot, registerAsset } from "../lib/production-records.ts";
import { createRole } from "../lib/role-records.ts";

const options = { appVersion: "test", persistenceKey: "frameflow-v0.1-canvas" };
const DAY = 24 * 3600 * 1000;
const noon = new Date(2026, 10, 10, 12, 0, 0).getTime();

// 1. navigator.storage.persist(): persisted() is asked first; persist() only when not yet persistent.
{
  let asked = 0;
  assert.equal(await ensurePersistentStorage({ persisted: async () => true, persist: async () => { asked += 1; return true; } }), "persisted");
  assert.equal(asked, 0, "already persistent → persist() is not called");
  assert.equal(await ensurePersistentStorage({ persisted: async () => false, persist: async () => { asked += 1; return true; } }), "granted");
  assert.equal(asked, 1);
  assert.equal(await ensurePersistentStorage({ persisted: async () => false, persist: async () => false }), "denied");
  assert.equal(await ensurePersistentStorage({}), "unsupported");
  assert.equal(await ensurePersistentStorage(undefined), "unsupported");
  assert.equal(await ensurePersistentStorage({ persisted: async () => { throw new Error("x"); }, persist: async () => true }), "error");
  assert.equal(isPersistent("granted"), true);
  assert.equal(isPersistent("denied"), false);
  assert.match(persistenceLabel("persisted"), /^已持久化/);
  assert.match(persistenceLabel("denied"), /^浏览器未允许/);
  for (const state of [null, "persisted", "granted", "denied", "unsupported", "error"]) assert.ok(persistenceLabel(state).length > 0);
}

// 2. Day keys and pruning.
{
  assert.equal(localDay(noon), "2026-11-10");
  assert.equal(localDay(new Date(2026, 0, 3, 23, 59).getTime()), "2026-01-03");
  const days = Array.from({ length: 9 }, (_, i) => localDay(noon + i * DAY));
  assert.deepEqual(daysToPrune(days), [days[1], days[0]]);
  assert.deepEqual(daysToPrune(days.slice(0, 7)), []);
  assert.equal(DAILY_BACKUP_KEEP, 7);
}

// 3. Empty project: nothing is saved (an emptied canvas never pushes out the good copies).
{
  databases.clear();
  const result = await runDailyBackup(null, { ...options, now: noon });
  assert.equal(result.status, "empty");
  assert.deepEqual(await listDailyBackups(), []);
}

// 4. Real project: canvas + records saved, media NOT included; once per day.
databases.clear();
const imageRef = await storeLocalImage(new Blob(["PNG-bytes"], { type: "image/png" }), "lin.png");
const image = await registerAsset({ kind: "image", origin: "imported", filename: "lin.png", mimeType: "image/png", storageReference: imageRef, sourceRunId: null, width: 64, height: 64 });
await createShot("镜头 1", "shape:h3");
await createRole("李四");
const canvasDoc = (label) => ({ store: { "page:1": { id: "page:1", typeName: "page", name: "Page 1" }, "shape:img": { id: "shape:img", typeName: "shape", type: "image-node", parentId: "page:1", props: { src: imageRef, label } } }, schema: { schemaVersion: 2 } });
{
  const result = await runDailyBackup(canvasDoc("v1"), { ...options, now: noon });
  assert.equal(result.status, "saved");
  const manifest = result.summary.manifest;
  assert.equal(manifest.lightweight, true);
  assert.equal(manifest.counts.images, 0, "no media in a light backup");
  assert.equal(manifest.counts.assets, 1);
  assert.equal(manifest.counts.shots, 1);
  assert.equal(manifest.counts.roles, 1);
  assert.equal(manifest.media.length, 0);
  assert.ok(manifest.warnings.includes(LIGHT_BACKUP_NOTE));
  assert.ok(!manifest.warnings.some((warning) => warning.startsWith("missingMedia:")), "media left out on purpose is not reported as missing");
  const files = await dailyBackupFiles("2026-11-10");
  assert.deepEqual(Object.keys(files).sort(), ["canvas.json", "director-stage.json", "manifest.json", "records.json"]);
  assert.ok(!Object.keys(files).some((path) => path.startsWith("media/")));
  const again = await runDailyBackup(canvasDoc("v2"), { ...options, now: noon + 3600_000 });
  assert.equal(again.status, "exists", "second run on the same day does nothing");
  assert.equal(JSON.parse((await dailyBackupFiles("2026-11-10"))["canvas.json"]).document.store["shape:img"].props.label, "v1");
}

// 5. Nine days in a row → only the newest 7 remain, newest first.
{
  for (let i = 1; i < 9; i += 1) assert.equal((await runDailyBackup(canvasDoc(`day${i}`), { ...options, now: noon + i * DAY })).status, "saved");
  const list = await listDailyBackups();
  assert.equal(list.length, 7);
  assert.equal(list[0].day, localDay(noon + 8 * DAY));
  assert.equal(list.at(-1).day, localDay(noon + 2 * DAY));
  assert.equal(await dailyBackupFiles("2026-11-10"), null, "files of pruned days are deleted too");
  assert.equal(await dailyBackupFiles(localDay(noon + DAY)), null);
}

// 6. A daily backup restores canvas + records through the normal restore path; media stays.
{
  const day = localDay(noon + 5 * DAY);
  const parsed = await readDailyBackup(day);
  assert.equal(parsed.manifest.lightweight, true);
  assert.equal(parsed.media.length, 0);
  assert.ok(!parsed.warnings.some((warning) => warning.startsWith("missingMedia:")));
  await createShot("镜头 2（备份之后才建）", "shape:h3b");
  assert.equal((await collectProject()).records.shots.length, 2);
  let canvasState = canvasDoc("broken");
  const report = await restoreProject(parsed, { current: () => canvasState, load: (document) => { canvasState = structuredClone(document); } });
  assert.equal(report.ok, true, JSON.stringify(report));
  const after = await collectProject();
  assert.equal(after.records.shots.length, 1, "records are back to that day");
  assert.equal(after.records.assets[0].assetId, image.assetId);
  assert.equal(after.media.images.length, 1, "media in the browser is untouched");
  assert.equal(canvasState.store["shape:img"].props.label, "day5");
  await assert.rejects(readDailyBackup("1999-01-01"), /找不到/);
}

console.log("daily backup + storage persistence tests passed");
