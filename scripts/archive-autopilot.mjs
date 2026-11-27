import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AutopilotStore, isAlive } from "./autopilot-ledger.ts";

const hashFile = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** Independent directory archive: no worker, ComfyUI, Python or GPU is started. */
export async function archiveAutopilot(root, destination) {
  root = resolve(root); destination = resolve(destination);
  const inside = relative(root, destination);
  if (!inside || (!inside.startsWith("..") && !isAbsolute(inside))) throw new Error("归档目标不能放在 runtime/autopilot 内部");
  if ((await lstat(root)).isSymbolicLink()) throw new Error("不归档符号链接目录");
  const store = new AutopilotStore(root);
  const owner = await store.readLock();
  if (owner && (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.instance !== "string" || !Number.isFinite(Date.parse(owner.heartbeat)))) throw new Error("夜班锁文件无法解析，请正常停止服务并检查锁文件后再归档");
  if (!owner) {
    // A malformed lock cannot safely be assumed to belong to a stopped worker.
    try { await lstat(store.lockPath); throw new Error("夜班锁文件无法解析，请正常停止服务并检查锁文件后再归档"); }
    catch (cause) { if (cause.code !== "ENOENT") throw cause; }
  }
  if (owner && isAlive(owner.pid)) throw new Error("夜班服务仍在运行，请等待任务完成并正常停止本地服务器，再归档（关闭浏览器不会停止夜班）");
  const instance = `archive-${randomUUID()}`;
  if (!(await store.acquireLock(instance, Number.POSITIVE_INFINITY)).ok) throw new Error("夜班账本正在使用，拒绝归档");
  let heartbeat;
  let heartbeatTask = Promise.resolve();
  const archive = join(destination, `frameflow-night-${Date.now()}-${randomUUID().slice(0, 8)}`);
  try {
    let lost = false;
    heartbeat = setInterval(() => { heartbeatTask = heartbeatTask.then(() => store.refreshLock(instance)).then((ok) => { if (!ok) lost = true; }, () => { lost = true; }); }, 1000);
    await mkdir(destination, { recursive: true });
    await mkdir(archive);
    await mkdir(join(archive, "data"));
    const files = [];
    const copy = async (folder) => {
      for (const name of await readdir(folder)) {
        const source = join(folder, name);
        if (source === store.lockPath) continue;
        const info = await lstat(source);
        if (info.isSymbolicLink()) throw new Error(`拒绝符号链接：${source}`);
        const path = relative(root, source).replaceAll("\\", "/");
        const target = join(archive, "data", path);
        if (info.isDirectory()) { await mkdir(target, { recursive: true }); await copy(source); }
        else if (info.isFile()) {
          await mkdir(resolve(target, ".."), { recursive: true });
          const before = await hashFile(source);
          await copyFile(source, target);
          if (before !== await hashFile(target) || before !== await hashFile(source)) throw new Error(`归档期间文件变化：${path}`);
          files.push({ path, size: (await lstat(target)).size, sha256: before });
        } else throw new Error(`不支持的文件类型：${source}`);
      }
    };
    await copy(root);
    if (lost || (await store.readLock())?.instance !== instance) throw new Error("归档锁丢失");
    await writeFile(join(archive, "manifest.json"), JSON.stringify({ format: "frameflow-night-archive-v1", exportedAt: new Date().toISOString(), excludes: ["worker.lock"], files }, null, 2), { flag: "wx" });
    return archive;
  } catch (cause) { throw new Error(`夜班归档未完成，不完整目录不可恢复：${archive}；${cause.message}`, { cause }); }
  finally { clearInterval(heartbeat); await heartbeatTask; await store.releaseLock(instance); }
}

export async function verifyNightArchive(archive) {
  const manifest = JSON.parse(await readFile(join(archive, "manifest.json"), "utf8"));
  if (manifest.format !== "frameflow-night-archive-v1" || !Array.isArray(manifest.files)) throw new Error("不是完整夜班归档");
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || !entry.path || entry.path.includes(":") || entry.path.split(/[\\/]/).some((p) => p === ".." || p === "." || !p) || isAbsolute(entry.path)) throw new Error("无效归档路径");
    const file = join(archive, "data", entry.path);
    if ((await lstat(file)).isSymbolicLink() || (await lstat(file)).size !== entry.size || await hashFile(file) !== entry.sha256) throw new Error(`归档校验失败：${entry.path}`);
  }
  return manifest.files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , option, value] = process.argv;
    if (option === "--verify" && value) console.log(`夜班归档校验通过：${await verifyNightArchive(resolve(value))} 个文件`);
    else if (option === "--destination" && value) console.log(`夜班归档完成：${await archiveAutopilot(process.env.FRAMEFLOW_AUTOPILOT_DIR || fileURLToPath(new URL("../runtime/autopilot", import.meta.url)), value)}`);
    else throw new Error('用法：node scripts/archive-autopilot.mjs --destination "备份目录" 或 --verify "归档目录"');
  } catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
