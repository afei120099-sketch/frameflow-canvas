import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { EPISODE_ID_PATTERN, MEDIA_NAME_PATTERN, PRODUCTION_SCHEMA, type Episode } from "../lib/production/types.ts";

/**
 * Production ledger on disk (default <project>/runtime/production):
 *
 *   episodes/<episodeId>.json        the episode ledger — source of truth, replaced atomically
 *   <episodeId>/inputs/<name>        uploaded storyboards, faces, role images
 *   <episodeId>/keyframes/…png       keyframe candidates (+ their depth maps)
 *   <episodeId>/videos/…mp4          video candidates
 *   <episodeId>/output/…mp4          assembled cuts
 *   <episodeId>/production.log       one JSON line per action
 *   worker.lock                      which dev-server process owns the worker
 */

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ProductionStore {
  private readonly writes = new Map<string, Promise<void>>();
  private sequence = 0;
  readonly root: string;
  constructor(root: string) { this.root = root; }

  get episodesDir() { return join(this.root, "episodes"); }
  get lockPath() { return join(this.root, "worker.lock"); }
  episodePath(id: string) { return join(this.episodesDir, `${id}.json`); }
  episodeDir(id: string) { assertEpisodeId(id); return join(this.root, id); }
  inputPath(id: string, name: string) {
    if (!MEDIA_NAME_PATTERN.test(name)) throw new Error(`素材文件名不可用：${name}`);
    return join(this.episodeDir(id), "inputs", name);
  }
  /** Resolves a path stored in the ledger (relative to the episode folder) without allowing escape. */
  resolve(id: string, file: string) {
    const base = this.episodeDir(id);
    const full = normalize(join(base, file));
    if (!full.startsWith(base + sep)) throw new Error("文件路径越界");
    return full;
  }
  relative(id: string, full: string) { return relative(this.episodeDir(id), full).split(sep).join("/"); }

  async init() { await mkdir(this.episodesDir, { recursive: true }); }

  async atomicWrite(target: string, data: string | Uint8Array) {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${++this.sequence}.tmp`;
    const handle = await open(temp, "w");
    try { await handle.writeFile(data as never); await handle.sync(); } finally { await handle.close(); }
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temp, target); return; }
      catch (cause) {
        if (attempt < 8 && RETRYABLE.has((cause as NodeJS.ErrnoException).code ?? "")) { await pause(25 * (attempt + 1)); continue; }
        await rm(temp, { force: true }).catch(() => {});
        throw cause;
      }
    }
  }

  /** Writes of one episode are serialized: an older snapshot can never land after a newer one. */
  writeEpisode(episode: Episode) {
    const text = `${JSON.stringify(episode, null, 2)}\n`;
    const run = () => this.atomicWrite(this.episodePath(episode.episodeId), text);
    const next = (this.writes.get(episode.episodeId) ?? Promise.resolve()).then(run, run);
    this.writes.set(episode.episodeId, next);
    void next.finally(() => { if (this.writes.get(episode.episodeId) === next) this.writes.delete(episode.episodeId); }).catch(() => {});
    return next;
  }

  async readEpisode(id: string): Promise<Episode | null> {
    assertEpisodeId(id);
    try { return JSON.parse(await readFile(this.episodePath(id), "utf8")) as Episode; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
  }

  /** All ledgers. Unreadable ones are reported, never deleted or "repaired". */
  async readAll() {
    const episodes: Episode[] = []; const damaged: { file: string; error: string }[] = [];
    for (const name of await readdir(this.episodesDir).catch(() => [] as string[])) {
      if (!name.endsWith(".json") || !EPISODE_ID_PATTERN.test(name.slice(0, -5))) continue;
      try {
        const episode = JSON.parse(await readFile(join(this.episodesDir, name), "utf8")) as Episode;
        if (episode?.schema !== PRODUCTION_SCHEMA || episode.episodeId !== name.slice(0, -5)) throw new Error("不是生产线剧集账本");
        episodes.push(episode);
      } catch (cause) { damaged.push({ file: name, error: cause instanceof Error ? cause.message : String(cause) }); }
    }
    return { episodes, damaged };
  }

  /** Moves an episode's ledger and folder into <root>/trash/<id>-<stamp>/ (restorable by moving back). */
  async trashEpisode(id: string, stamp: string) {
    assertEpisodeId(id);
    await (this.writes.get(id) ?? Promise.resolve()).catch(() => {});
    const target = join(this.root, "trash", `${id}-${stamp}`);
    await mkdir(target, { recursive: true });
    const move = async (from: string, to: string) => {
      for (let attempt = 0; ; attempt += 1) {
        try { await rename(from, to); return; }
        catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code ?? "";
          if (code === "ENOENT") return;
          if (attempt < 8 && RETRYABLE.has(code)) { await pause(50 * (attempt + 1)); continue; }
          throw cause;
        }
      }
    };
    await move(this.episodePath(id), join(target, `${id}.json`));
    await move(this.episodeDir(id), join(target, id));
    return relative(this.root, target).split(sep).join("/");
  }

  async exists(path: string) { try { return (await stat(path)).isFile(); } catch { return false; } }

  async log(id: string, entry: Record<string, unknown>) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    await mkdir(this.episodeDir(id), { recursive: true });
    await appendFile(join(this.episodeDir(id), "production.log"), line, "utf8").catch(() => {});
  }
}

export function assertEpisodeId(id: string) {
  if (!EPISODE_ID_PATTERN.test(id)) throw new Error("剧集 ID 格式不对");
}
