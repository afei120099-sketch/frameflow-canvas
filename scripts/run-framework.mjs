import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "./execution-profile.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) throw new Error("Expected dev or build.");
const managedLinux = readExecutionProfile() === "managed-linux";
if (command === 'dev' && process.platform === 'win32') {
  // Native recycling stays outside the worker, and cannot interrupt GPU work.
  const {startMediaTrashServer} = await import('./media-trash-server.mjs');
  try { await startMediaTrashServer(); }
  catch (error) { console.warn('回收站助手暂不可用；画布正常启动，文件清理保持禁用。', error.message); }
}
if (command === 'dev' && process.platform === 'win32') {
  // Canvas /api/inbox proxies to 127.0.0.1:5193. Reboot does not start this helper.
  // Use `pnpm dev` (this file) or, if 5173 is already up: `pnpm inbox:server` / `node scripts/inbox-server.mjs`.
  try { await (await import('./inbox-server.mjs')).startInboxServer(); }
  catch (error) { console.warn('inbox helper unavailable:', error.message); }
} // Frameflow inbox autorun
if (command === 'dev' && process.platform === 'win32') { try { await (await import('./clipboard-image-server.mjs')).startClipboardImageServer(); } catch (error) { console.warn('clipboard image helper unavailable:', error.message); } }

if (managedLinux && command === "build") {
  const result = spawnSync("bash", [
    fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(managedLinux
  ? "../node_modules/vite/bin/vite.js"
  : "../node_modules/vinext/dist/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []), ...args];
await import(cli.href);
