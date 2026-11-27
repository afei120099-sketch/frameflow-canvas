import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local Blender runtime for the white-box bridge: the official portable build (no install, no add-ons,
 * its own Python). FRAMEFLOW_BLENDER points at blender.exe; otherwise the newest blender-*-windows-x64 under
 * FRAMEFLOW_BLENDER_SEARCH_DIR (unset = no search).
 * Looked up per call, so unpacking Blender later needs no dev-server restart.
 */
export const WHITEBOX_RENDER_SCRIPT = fileURLToPath(new URL("../tools/blender/whitebox_render.py", import.meta.url));

export function findBlender(): string | null {
  const configured = process.env.FRAMEFLOW_BLENDER;
  if (configured) return existsSync(configured) ? configured : null;
  const PORTABLE_ROOT = process.env.FRAMEFLOW_BLENDER_SEARCH_DIR;
  if (!PORTABLE_ROOT || !existsSync(PORTABLE_ROOT)) return null;
  const builds = readdirSync(PORTABLE_ROOT).filter((name) => /^blender-[\d.]+-windows-x64$/.test(name)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const build of builds) { const exe = join(PORTABLE_ROOT, build, "blender.exe"); if (existsSync(exe)) return exe; }
  return null;
}
