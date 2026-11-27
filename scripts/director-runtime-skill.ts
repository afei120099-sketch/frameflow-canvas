import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MACHINE_SYNTAX } from "../lib/autopilot-director.ts";

/**
 * Director Runtime Skill: the Frameflow planning rules (config/director-runtime-skill.md).
 * It is injected, as plain text, at the top of every director's system prompt — the same text for every provider.
 * Version (front matter) and a SHA-256 of the injected body are recorded with each job, so rule changes are traceable.
 *
 * It only covers director planning. H3 prompt syntax stays with the official h3-prompt-writing skill and the
 * deterministic compiler, so the file is rejected if it contains any H3 machine syntax.
 */

export const DIRECTOR_RUNTIME_SKILL_FILE = new URL("../config/director-runtime-skill.md", import.meta.url);
export interface DirectorRuntimeSkill { version: string; hash: string; text: string }

const H3_FIELD_NAMES = /integrated_multimodal_description|overall_soundscape|non_diegetic_music|subject_definitions|retention_analysis|detailed_description/i;

export function loadDirectorRuntimeSkill(path: string | URL = DIRECTOR_RUNTIME_SKILL_FILE): DirectorRuntimeSkill {
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!front) throw new Error("导演运行规则缺少版本信息（front matter）");
  const version = /^version:\s*(\S+)\s*$/m.exec(front[1])?.[1];
  if (!version) throw new Error("导演运行规则缺少 version");
  const text = raw.slice(front[0].length).trim();
  if (!text) throw new Error("导演运行规则内容为空");
  // Director planning only: H3 labels / field names belong to the compiler.
  if (MACHINE_SYNTAX.test(text) || H3_FIELD_NAMES.test(text)) throw new Error("导演运行规则里出现了 H3 机器语法（这部分只属于编译器）");
  return { version, text, hash: createHash("sha256").update(text).digest("hex") };
}
