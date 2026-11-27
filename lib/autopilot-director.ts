import { z } from "zod";
import type { H3GenerationSettings } from "./ai-adapter.ts";
import { compileH3Prompt } from "./comfyui/h3-prompt.ts";
import { H3_FPS, H3_LORA_STRENGTH, H3_MAX_LENGTH, H3_MEGAPIXELS, H3_MIN_LENGTH, H3_RESOLUTION_STEPS, H3_STEPS, H3_TURBO, H3_UPSCALE_METHOD, lengthToSeconds, secondsToH3Length } from "./comfyui/h3-parameters.ts";
import { t2vaDimensions } from "./comfyui/h3-t2va.ts";
import { frameModeCounts, runH3Preflight } from "./h3-preflight.ts";

/**
 * Autopilot M2: one sentence → DirectorPlan → N T2VA Shots.
 *
 *   Director Provider (a model)      decides WHAT to shoot and HOW: structured semantic fields only.
 *   H3 T2VA Compiler (this module)   turns an approved Shot into MiniMax's official T2VA prompt
 *                                    (h3-prompt-writing + base-en): [Shot 1], speaker ids, <d>[Lang] …</d>,
 *                                    camera wording, soundscape / music fields — deterministically.
 *
 * The model never writes machine syntax (<d>, [Chinese], S1, [Shot N], Picture/Audio/Subject labels);
 * any such text in its fields is rejected. The submitted prompt always comes from the compiler.
 */

export const M2_ASPECTS = ["9:16", "16:9", "1:1", "4:3", "3:4"] as const;
export type M2Aspect = (typeof M2_ASPECTS)[number];
export const M2_DEFAULT_ASPECT: M2Aspect = "9:16";
export const M2_DEFAULT_SECONDS = 30;
export const M2_SECONDS_RANGE = { min: 15, max: 60 } as const;
export const M2_SHOT_COUNT = { min: 3, max: 6 } as const;
export const M2_SHOT_SECONDS = { min: 4, max: 15 } as const;
export const M2_INTENT_MAX = 500;
export type M2PromptMode = "official" | "plain";
export const M2_DIRECTOR_SCHEMA_VERSION = 2;
/** v3: optional Subject Anchor sentences (without an anchor the output is byte-identical to v2). */
export const M2_COMPILER_VERSION = "autopilot-m2-t2va-compiler-v3";
/** Speaking-rate ceilings used to decide whether dialogue fits inside a Shot. */
export const DIALOGUE_RATE = { chineseCharsPerSecond: 4.5, englishWordsPerSecond: 3 } as const;

/** base-en camera vocabulary (motion type); amplitude / speed are separate fields. */
export const CAMERA_MOTIONS = ["static", "push_in", "pull_out", "zoom_in", "zoom_out", "pan_left", "pan_right", "truck_left", "truck_right", "tilt_up", "tilt_down", "pedestal_up", "pedestal_down", "arc", "tracking", "shake_slightly", "pov"] as const;
export type CameraMotion = (typeof CAMERA_MOTIONS)[number];

/** H3 machine syntax that belongs to the compiler, never to Director fields. */
export const MACHINE_SYNTAX = /<\/?d>|\[\s*(Chinese|English|Shot\s*\d+)\s*\]|\(\s*S\d+(\s*,\s*S\d+)*\s*\)|\bS\d+\b|<\s*(Picture|Image|Video|Audio|Subject)\s*\d+\s*>|\b(Picture|Video|Audio|Subject)\s+\d+\b|\b(integrated_multimodal_description|overall_soundscape|non_diegetic_music)\b/i;
export const MACHINE_MESSAGE = "不能包含 H3 机器语法（<d>、[Chinese]、S1、[Shot N]、Picture / Audio / Subject 标签、字段名）——这些由编译器生成";

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !MACHINE_SYNTAX.test(value), { message: MACHINE_MESSAGE });

export const DirectorCharacterSchema = z.object({
  id: text(40),
  /** Display name, any language (e.g. 柴犬). */
  name: text(40),
  /** English noun phrase used by the compiler, e.g. "a fluffy tan Shiba Inu with a red collar". */
  description: text(200),
});

export const DirectorDialogueSchema = z.object({
  /** Character id from plan.characters. */
  speaker: text(40),
  /** The real words only, in their original language. */
  text: text(200),
  language: z.enum(["Chinese", "English"]),
  /** English, e.g. "a bright, playful young voice, speaking quickly". */
  delivery: text(160),
  onScreenSpeaking: z.boolean(),
  voiceover: z.boolean(),
});

export const DirectorCameraSchema = z.object({
  /** English, e.g. "medium shot", "close-up". */
  shotSize: text(60),
  motion: z.enum(CAMERA_MOTIONS),
  amplitude: z.enum(["small", "medium", "large"]),
  speed: z.enum(["slow", "normal", "fast"]),
  /** English, what the camera moves toward / follows; null for none. */
  target: text(120).nullable(),
});

export const DirectorShotSchema = z.object({
  index: z.number().int().min(1).max(M2_SHOT_COUNT.max),
  title: text(40),
  /** 镜头目标 (display, any language). */
  purpose: text(300),
  plannedDurationSeconds: z.number().min(M2_SHOT_SECONDS.min).max(M2_SHOT_SECONDS.max),
  /** English sentences — the compiler quotes them into the timeline. */
  openingState: text(400),
  event: text(400),
  endingState: text(400),
  /** Character ids visible in this Shot. */
  characters: z.array(text(40)).max(4),
  camera: DirectorCameraSchema,
  allowedCameraMotion: z.array(z.enum(CAMERA_MOTIONS)).max(CAMERA_MOTIONS.length),
  forbiddenCameraMotion: z.array(z.enum(CAMERA_MOTIONS)).max(CAMERA_MOTIONS.length),
  invariants: z.array(text(160)).max(6),
  dialogue: z.array(DirectorDialogueSchema).max(3),
  ambientSound: text(240),
  physicalSounds: z.array(text(120)).max(6),
  /** Non-verbal human / animal sounds (breathing, laughter, a bark). Never speech. */
  nonVerbalSounds: z.array(text(120)).max(4),
  nonDiegeticMusicIntent: text(240).nullable(),
  visualConstraints: z.array(text(160)).max(6),
  /** Content that must not appear; checked against the compiled prompt, never written into it. */
  forbiddenContent: z.array(text(120)).max(8),
  /** Product / brand statements this Shot conveys; each must be one of the approved facts. */
  productClaims: z.array(text(200)).max(4),
});

export const DirectorPlanSchema = z.object({
  title: text(60),
  logline: text(300),
  /** English style line for every Shot, e.g. "Live-action, handheld smartphone footage". */
  style: text(160),
  characters: z.array(DirectorCharacterSchema).max(4),
  shots: z.array(DirectorShotSchema).min(M2_SHOT_COUNT.min).max(M2_SHOT_COUNT.max),
});

export type DirectorPlan = z.infer<typeof DirectorPlanSchema>;
export type DirectorShot = z.infer<typeof DirectorShotSchema>;
export type DirectorCharacter = z.infer<typeof DirectorCharacterSchema>;

const stringArray = (maxItems: number) => ({ type: "array", items: { type: "string" }, maxItems });
const motionArray = { type: "array", items: { type: "string", enum: [...CAMERA_MOTIONS] } };
/**
 * Same shape as DirectorPlanSchema for constrained decoding (LM Studio json_schema). There is no
 * prompt field for the model to fill: the executable prompt only exists after compilation.
 */
export const DIRECTOR_PLAN_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "logline", "style", "characters", "shots"],
  properties: {
    title: { type: "string" }, logline: { type: "string" }, style: { type: "string" },
    characters: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["id", "name", "description"], properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } } } },
    shots: {
      type: "array", minItems: M2_SHOT_COUNT.min, maxItems: M2_SHOT_COUNT.max,
      items: {
        type: "object", additionalProperties: false,
        required: ["index", "title", "purpose", "plannedDurationSeconds", "openingState", "event", "endingState", "characters", "camera", "allowedCameraMotion", "forbiddenCameraMotion", "invariants", "dialogue", "ambientSound", "physicalSounds", "nonVerbalSounds", "nonDiegeticMusicIntent", "visualConstraints", "forbiddenContent", "productClaims"],
        properties: {
          index: { type: "integer" }, title: { type: "string" }, purpose: { type: "string" },
          plannedDurationSeconds: { type: "number", minimum: M2_SHOT_SECONDS.min, maximum: M2_SHOT_SECONDS.max },
          openingState: { type: "string" }, event: { type: "string" }, endingState: { type: "string" },
          characters: stringArray(4),
          camera: { type: "object", additionalProperties: false, required: ["shotSize", "motion", "amplitude", "speed", "target"], properties: { shotSize: { type: "string" }, motion: { type: "string", enum: [...CAMERA_MOTIONS] }, amplitude: { type: "string", enum: ["small", "medium", "large"] }, speed: { type: "string", enum: ["slow", "normal", "fast"] }, target: { anyOf: [{ type: "null" }, { type: "string" }] } } },
          allowedCameraMotion: motionArray, forbiddenCameraMotion: motionArray,
          invariants: stringArray(6),
          dialogue: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["speaker", "text", "language", "delivery", "onScreenSpeaking", "voiceover"], properties: { speaker: { type: "string" }, text: { type: "string" }, language: { type: "string", enum: ["Chinese", "English"] }, delivery: { type: "string" }, onScreenSpeaking: { type: "boolean" }, voiceover: { type: "boolean" } } } },
          ambientSound: { type: "string" }, physicalSounds: stringArray(6), nonVerbalSounds: stringArray(4),
          nonDiegeticMusicIntent: { anyOf: [{ type: "null" }, { type: "string" }] },
          visualConstraints: stringArray(6), forbiddenContent: stringArray(8), productClaims: stringArray(4),
        },
      },
    },
  },
} as const;

export interface CompiledSpeaker { speakerId: string; characterId: string; name: string }

export interface CompiledDirectorShot {
  index: number;
  title: string;
  /** Director layer: the validated semantic Shot, exactly as the model returned it. */
  semantic: DirectorShot;
  plannedSeconds: number;
  length: number;
  actualSeconds: number;
  speakers: CompiledSpeaker[];
  compilerVersion: string;
  /** Compiler output: MiniMax official T2VA three-field prompt. */
  officialPrompt: string;
  /** Internal A/B / diagnosis only: the semantic fields as plain text. */
  plainPrompt: string;
  /** Exactly what goes to ComfyUI for the chosen mode (always compiler-derived). */
  submitPrompt: string;
  source: { plan: "director"; prompt: "compiler" };
  settings: H3GenerationSettings;
  warnings: string[];
}

export interface DirectorCompileResult {
  ok: boolean;
  /** Messages of `issues`, same order. */
  errors: string[];
  issues: PlanIssue[];
  warnings: string[];
  plan: DirectorPlan | null;
  shots: CompiledDirectorShot[];
  totalSeconds: number;
  compilerVersion: string;
}

/**
 * Hard constraints of one request. Enforced by compileDirectorPlan for every provider alike (mock, local,
 * cloud): the brief tells the model, the validator decides. Any violation makes the plan invalid.
 */
export interface DirectorConstraints {
  /** false → no spoken line anywhere (no dialogue entries, no one described as saying / narrating anything). */
  allowDialogue: boolean;
  /** false → no readable writing: on-screen text, signs, labels, stamps, captions, posters, readable paper / package / phone text. */
  allowReadableText: boolean;
  /** false → no generated software: apps, mini-programs, dashboards, buttons, software pages, phone UI, fake screenshots. */
  allowGeneratedUI: boolean;
  /** false → no amounts, percentages, discounts, performance figures, user / deal counts, savings or ratings unless an approved fact states them. */
  allowNumbers: boolean;
  /** false → no voiceover / off-screen narration; every line is spoken on screen. */
  allowVoiceover: boolean;
}
export const DEFAULT_DIRECTOR_CONSTRAINTS: DirectorConstraints = { allowDialogue: true, allowReadableText: false, allowGeneratedUI: false, allowNumbers: false, allowVoiceover: true };
export const DIRECTOR_CONSTRAINT_KEYS = Object.keys(DEFAULT_DIRECTOR_CONSTRAINTS) as (keyof DirectorConstraints)[];
/** Missing / non-boolean values fall back to the (conservative) defaults. */
export function normalizeConstraints(input?: Partial<Record<keyof DirectorConstraints, unknown>> | null): DirectorConstraints {
  const result = { ...DEFAULT_DIRECTOR_CONSTRAINTS };
  for (const key of DIRECTOR_CONSTRAINT_KEYS) if (typeof input?.[key] === "boolean") result[key] = input[key] as boolean;
  return result;
}

/**
 * Subject Anchor: what the main subject IS and the scene it belongs to, fixed by the user / project for every
 * Shot. The director only decides what the subject DOES; the compiler writes these sentences itself, once per
 * Shot, so no model reply can redefine the subject. English (they go into the English prompt verbatim).
 */
export interface SubjectAnchor {
  /** Display name, any language (e.g. 现代垂直起降战斗机). Not written into the prompt. */
  subjectName: string;
  subjectDescription: string;
  /** Optional shared scene / vehicle base; "" for none. */
  sceneAnchor: string;
}
export const SUBJECT_ANCHOR_LIMITS = { subjectName: 40, subjectDescription: 300, sceneAnchor: 300 } as const;

/** Null when nothing was filled in; throws a Chinese message when the anchor cannot be used as given. */
export function normalizeSubjectAnchor(input: unknown): SubjectAnchor | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const clean = (key: keyof SubjectAnchor) => typeof raw[key] === "string" ? (raw[key] as string).trim().replace(/\s+/g, " ").replace(/[.。]+$/, "") : "";
  const anchor: SubjectAnchor = { subjectName: clean("subjectName"), subjectDescription: clean("subjectDescription"), sceneAnchor: clean("sceneAnchor") };
  if (!anchor.subjectName && !anchor.subjectDescription && !anchor.sceneAnchor) return null;
  if (!anchor.subjectDescription) throw new Error("主体锚点需要填写主体描述（subjectDescription）");
  for (const key of ["subjectName", "subjectDescription", "sceneAnchor"] as const) if (anchor[key].length > SUBJECT_ANCHOR_LIMITS[key]) throw new Error(`主体锚点 ${key} 最多 ${SUBJECT_ANCHOR_LIMITS[key]} 个字符`);
  for (const key of ["subjectDescription", "sceneAnchor"] as const) {
    if (CJK.test(anchor[key])) throw new Error(`主体锚点 ${key} 需用英文（会原样写进英文 Prompt）`);
    if (MACHINE_SYNTAX.test(anchor[key])) throw new Error(`主体锚点 ${key} ${MACHINE_MESSAGE}`);
  }
  if (!anchor.subjectName) anchor.subjectName = "主体";
  return anchor;
}

/** The two fixed sentences the compiler adds to every Shot (only these carry the anchor text). */
export function anchorSentences(anchor: SubjectAnchor | null | undefined) {
  if (!anchor) return [];
  return [`The main subject is ${anchor.subjectDescription}.`, ...(anchor.sceneAnchor ? [`The scene includes ${anchor.sceneAnchor}.`] : [])];
}

export interface CompileOptions {
  targetSeconds: number;
  aspect: M2Aspect;
  promptMode: M2PromptMode;
  /** The user's sentence (decides whether dialogue must stay Chinese). */
  intent?: string;
  /** Product / brand facts the plan may state; nothing else specific may be claimed. */
  approvedFacts?: string[];
  forbiddenClaims?: string[];
  /** Hard constraints; defaults to DEFAULT_DIRECTOR_CONSTRAINTS. */
  constraints?: Partial<DirectorConstraints>;
  /** User / project Subject Anchor, written by the compiler into every Shot (never taken from the plan). */
  subjectAnchor?: SubjectAnchor | null;
}

export function m2Settings(aspect: M2Aspect, length: number, promptMode: M2PromptMode): H3GenerationSettings {
  return {
    length, aspect, megapixels: H3_MEGAPIXELS, turbo: H3_TURBO, steps: H3_STEPS, fps: H3_FPS, loraStrength: H3_LORA_STRENGTH,
    upscaleMethod: H3_UPSCALE_METHOD, resolutionSteps: H3_RESOLUTION_STEPS,
    // Official mode describes sound in its own fields; plain mode keeps the verified ambient-only suffix.
    soundMode: promptMode === "official" ? "av" : "ambient",
  };
}

/** Pulls the JSON object out of a model reply (tolerates ```json fences and text around it). */
export function extractPlanJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{"); const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("导演模型的回复里没有 JSON 计划");
  try { return JSON.parse(body.slice(start, end + 1)); }
  catch (cause) { throw new Error(`导演计划 JSON 无法解析：${cause instanceof Error ? cause.message : String(cause)}`); }
}

// ——— compiler ———

const CJK = /[㐀-鿿豈-﫿]/;
const HAN = /[㐀-鿿]/;
const HAN_ALL = /[㐀-鿿]/g;
const REFERENCE_TAG = /<\s*(Picture|Image|Video|Audio|Subject)\s*\d+\s*>|\b(Picture|Video|Audio|Subject)\s+\d+\b/i;
const outsideDialogue = (value: string) => value.replace(/<d>[\s\S]*?<\/d>/g, " ");
const words = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;
const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
/** One English sentence: capitalised, ending in . ! or ? (a closing quote after the stop counts). */
const sentence = (value: string) => { const trimmed = capital(value.trim().replace(/\s+/g, " ")); return /[.!?]["'”’)]?$/.test(trimmed) ? trimmed : `${trimmed}.`; };
const article = (noun: string) => /^(a|an|the)\s/i.test(noun) ? "" : /^[aeiou]/i.test(noun) ? "an " : "a ";
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const MOTION_TEXT: Record<CameraMotion, string> = {
  static: "holds a static shot", push_in: "pushes in", pull_out: "pulls out", zoom_in: "zooms in", zoom_out: "zooms out",
  pan_left: "pans left", pan_right: "pans right", truck_left: "trucks left", truck_right: "trucks right", tilt_up: "tilts up", tilt_down: "tilts down",
  pedestal_up: "pedestals up", pedestal_down: "pedestals down", arc: "arcs around", tracking: "tracks", shake_slightly: "shakes slightly", pov: "moves as a first-person POV",
};

/** base-en: motion type + amplitude + speed (medium / normal omitted) as a natural sentence. */
export function cameraSentence(camera: DirectorShot["camera"]) {
  const parts = [`The camera ${MOTION_TEXT[camera.motion]}`];
  if (camera.motion !== "static") {
    if (camera.amplitude !== "medium") parts.push(`with ${camera.amplitude} amplitude`);
    if (camera.speed !== "normal") parts.push(`at ${camera.speed} speed`);
  }
  let tail = "";
  if (camera.target) {
    if (camera.motion === "static") parts.push(`on ${camera.target}`);
    else if (camera.motion === "tracking" || camera.motion === "arc") parts.splice(1, 0, camera.target);
    else if (/^(pan|truck)_/.test(camera.motion) || camera.motion === "shake_slightly" || camera.motion === "pov") tail = `, following ${camera.target}`;
    else parts.push(`toward ${camera.target}`);
  }
  return sentence(`${parts.join(" ")}${tail}`);
}

/** base-en T2VA: no instruction line; the three core fields in order, separated by one blank line. */
export function assembleOfficialT2va(fields: { integrated_multimodal_description: string; overall_soundscape: string; non_diegetic_music: string }) {
  return `integrated_multimodal_description: ${fields.integrated_multimodal_description.trim()}\n\noverall_soundscape: ${fields.overall_soundscape.trim()}\n\nnon_diegetic_music: ${fields.non_diegetic_music.trim()}`;
}

/** Speaker ids in this Shot's actual vocal order; silent characters get none. */
export function assignSpeakers(shot: DirectorShot, characters: DirectorCharacter[]): CompiledSpeaker[] {
  const speakers: CompiledSpeaker[] = [];
  for (const line of shot.dialogue) {
    if (speakers.some((speaker) => speaker.characterId === line.speaker)) continue;
    const character = characters.find((item) => item.id === line.speaker);
    speakers.push({ speakerId: `S${speakers.length + 1}`, characterId: line.speaker, name: character?.name ?? line.speaker });
  }
  return speakers;
}

/** One Shot → the three official fields. Each plan Shot is its own H3 video, so it is always a single [Shot 1]. */
export function compileT2vaFields(shot: DirectorShot, plan: Pick<DirectorPlan, "style" | "characters">, aspect: M2Aspect, anchor?: SubjectAnchor | null) {
  const speakers = assignSpeakers(shot, plan.characters);
  const describe = (id: string) => plan.characters.find((character) => character.id === id)?.description ?? id;
  const style = aspect === "9:16" && !/vertical/i.test(plan.style) ? `${plan.style}, vertical framing` : plan.style;
  const dialogueSentences = shot.dialogue.map((line) => {
    const speaker = speakers.find((item) => item.characterId === line.speaker)!;
    const who = `${capital(describe(line.speaker))} (${speaker.speakerId}), ${line.delivery.replace(/[.。]$/, "")},`;
    const words = `<d>[${line.language}] ${line.text}</d>`;
    if (line.voiceover) return `${who} says in an off-screen voiceover: ${words} while the character's lips remain completely closed.`;
    if (!line.onScreenSpeaking) return `${who} speaks from off-screen: ${words}`;
    return `${who} says: ${words}`;
  });
  const body = [
    `[Shot 1] ${style}, ${article(shot.camera.shotSize)}${shot.camera.shotSize} frames the scene.`,
    ...anchorSentences(anchor),
    sentence(shot.openingState),
    cameraSentence(shot.camera),
    sentence(shot.event),
    ...dialogueSentences,
    sentence(shot.endingState),
    ...(shot.invariants.length ? [`Throughout the shot, ${list(shot.invariants.map((item) => item.replace(/[.。]$/, "")))} stay consistent.`] : []),
    ...shot.visualConstraints.map(sentence),
  ];
  const soundscape = [
    sentence(shot.ambientSound),
    ...(shot.physicalSounds.length ? [sentence(`${capital(list(shot.physicalSounds))} can be heard`)] : []),
    ...(shot.nonVerbalSounds.length ? [sentence(`Non-verbal sounds include ${list(shot.nonVerbalSounds)}`)] : []),
  ];
  return {
    speakers,
    fields: {
      integrated_multimodal_description: body.join(" "),
      overall_soundscape: soundscape.join(" "),
      non_diegetic_music: shot.nonDiegeticMusicIntent ? sentence(shot.nonDiegeticMusicIntent) : "N/A",
    },
  };
}

export function plainPromptFromShot(shot: DirectorShot, anchor?: SubjectAnchor | null) {
  return [...anchorSentences(anchor), shot.purpose, shot.openingState, shot.event, shot.endingState, ...shot.dialogue.map((line) => line.text)].map((part) => part.trim()).join(" ");
}

/** Legality of compiled official T2VA fields (the compiler's own self-check; also used by tests). */
export function checkOfficialT2va(fields: { integrated_multimodal_description: string; overall_soundscape: string; non_diegetic_music: string }, dialogueTexts: string[]): string[] {
  const problems: string[] = [];
  const imd = fields.integrated_multimodal_description.trim();
  if (!imd.startsWith("[Shot 1] ")) problems.push("integrated_multimodal_description 必须以 [Shot 1] 开头");
  if ((imd.match(/\[Shot \d+\]/g) ?? []).length !== 1) problems.push("M2 每个独立视频只能是一个 [Shot 1]");
  for (const [name, value] of Object.entries(fields)) {
    if (REFERENCE_TAG.test(value)) problems.push(`${name} 出现了参考素材标签（Picture / Video / Audio / Subject）：文生视频没有参考素材`);
    if (CJK.test(outsideDialogue(value))) problems.push(`${name} 在台词之外出现了中文：导演的描述字段需要英文（台词保持原文）`);
  }
  const blocks = [...imd.matchAll(/<d>\[(Chinese|English)\] ([\s\S]*?)<\/d>/g)].map((match) => match[2]);
  if ((imd.match(/<d>/g) ?? []).length !== blocks.length) problems.push("台词格式错误");
  for (const line of dialogueTexts) if (!blocks.includes(line)) problems.push(`台词“${line}”没有逐字进入 <d>`);
  if (!dialogueTexts.length && /\(S\d+\)|<d>/.test(imd)) problems.push("没有对白的镜头不能出现说话者编号或 <d>");
  if (words(outsideDialogue(imd)) < 25) problems.push("integrated_multimodal_description 太短");
  if (!fields.overall_soundscape.trim()) problems.push("overall_soundscape 不能为空");
  return problems;
}

// ——— hard constraints (identical for every provider) ———

/** Clauses that negate ("no captions", "不出现文字") state what must NOT appear; the text / UI rules skip them. */
const NEGATION = /\b(no|not|never|without|avoid|avoids|avoiding|free of|none|nothing|nobody)\b|n['’]t\b|无|不|没有|禁止|避免|别|勿/i;
const affirmativeClauses = (value: string) => value.split(/[.;!?。；！？\n]|,\s*|，/).map((clause) => clause.trim()).filter((clause) => clause && !NEGATION.test(clause));
/** Quoted words invite the video model to render them as text, negated or not. */
const QUOTED = /["“”「」『』]/;
const READABLE_EN = /\b(on-?screen text|text overlays?|captions?|subtitles?|title cards?|lower thirds?|headlines?|lettering|typography|legible|readable|handwrit\w*|inscri\w*|written (on|across|in)|words? (on|across|printed|written|appear\w*)|text (on|reads|says|appears|that|printed)|printed (text|words|with)|(reads|reading|spells?|spelling)\s*[:"“]|labell?ed|labels?|price tags?|stamped|rubber stamps?|stamps? (reading|marked|with)|posters?|signage|signboards?|billboards?|(road|street|shop|store|neon|warning|traffic|wooden|hanging|door|exit) signs?|banners? (with|reading)|screens? (shows?|displays?|showing|displaying|reads|lights? up with)|displays? (shows?|reads|showing)|charts?|graphs?|spreadsheets?|documents? (with|covered|full|showing)|(sticky|post-it) notes?)\b/i;
const READABLE_ZH = /屏幕上(显示|出现|写|有字)|显示(着|出)|写着|写有|写上|标着|标有|标注|印着|印有|标签|字幕|标题卡|海报|招牌|横幅|广告牌|路牌|贴纸|便签|便利贴|印章|盖章|字样|文字|字迹|价签|图表|表格/;
const UI_EN = /\b(apps?|application (screens?|interfaces?|windows?)|mini[- ]?programs?|dashboards?|user interfaces?|ui|gui|interfaces?|buttons?|icons?|pop-?ups?|notifications?|software|websites?|web ?pages?|screenshots?|screen ?recordings?|log-?in|menus?|progress bars?|sliders?|touch ?screens?|swip(e|es|ing) (through|on|across)|tap(s|ping)? (on )?(the |a )?(screen|icon|button)|(phone|smartphone|cellphone|mobile|tablet|ipad|laptop|computer|pc|monitor|tv|television|device)('s)? (screens?|displays?|interfaces?)|screen of (a|the|her|his|their|its) (phone|smartphone|tablet|laptop|computer|monitor)|holograph\w*|virtual (panels?|displays?|screens?)|digital (overlays?|graphics?|panels?)|infographics?|animated graphics?)\b/i;
const UI_ZH = /应用界面|小程序|仪表盘|仪表板|看板|数据面板|按钮|界面|软件|网页|网站|截图|录屏|弹窗|图标|手机屏幕|屏幕上的|操作页面|页面|登录|菜单|滑块|通知栏|推送/;
const SPEECH_EN = /\b(says?|said|saying|speaks?|spoke|speaking|talks?|talking|chats?|chatting|conversations?|dialogues?|shouts?|shouting|yells?|yelling|whispers?|whispering|announces?|announcing|exclaims?|mutters?|narrat\w*|voice-?overs?|radio (chatter|calls?|messages?|transmissions?)|calls? out|speech|spoken)\b/i;
const SPEECH_ZH = /说[：:“"]|说道|喊道|大喊|喊话|对话|对白|台词|旁白|解说|聊天|交谈|讲话|说话|独白/;
const VOICEOVER = /\b(narrat\w*|voice-?overs?|off-?screen voices?)\b|旁白|画外音|解说/i;
/** Numbers that are camera / timing specs, not claims. */
const TECHNICAL_NUMBER = /\d+(\.\d+)?\s*(mm|fps|k|p|°|-?\s*degrees?|秒|s|sec|seconds?)\b|\d+\s*:\s*\d+|\d+(\.\d+)?\s*(°|秒)/gi;
const DIGITS = /\d[\d,.]*/g;
const NUMBER_WORDS_EN = /\b(percent|per ?cent|half[- ]price|\w+[- ]percent|(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand|million|billion)[- ]?(star|stars|fold|times)|(hundreds|thousands|millions|billions|dozens) of (users|customers|people|families|households|orders|deals|homes|clients)|(thousand|million|billion)s?|\w+ times (faster|cheaper|more|less|better))\b/gi;
const NUMBER_WORDS_ZH = /[一二两三四五六七八九十][一二两三四五六七八九十百千万亿]*(元|块钱|万|千|百|亿|折|倍|个点|单|星)|[二两三四五六七八九十][一二两三四五六七八九十百千万亿]*块|百分之[一二两三四五六七八九十百]+|打[一二三四五六七八九]折|翻[一二两三四五六七八九十]?倍/g;
const squash = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const occurrences = (haystack: string, needle: string) => needle ? haystack.toLowerCase().split(needle.toLowerCase()).length - 1 : 0;
/** Whole-word match for Latin terms ("text" is not in "texture"); substring match otherwise. */
const mentions = (haystack: string, term: string) => {
  const needle = term.trim();
  if (!needle) return false;
  if (/^[\x20-\x7e]+$/.test(needle)) return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(haystack);
  return haystack.toLowerCase().includes(needle.toLowerCase());
};

/** Every number-like token (amount, percentage, count, rating…) outside technical camera specs. */
export function numberTokens(value: string): string[] {
  const text = value.replace(TECHNICAL_NUMBER, " ");
  return [...(text.match(DIGITS) ?? []), ...(text.match(NUMBER_WORDS_EN) ?? []), ...(text.match(NUMBER_WORDS_ZH) ?? [])];
}

/**
 * A product claim is approved when it is an approved fact, a verbatim part of one ("报价不等于装修总预算" of
 * "核心表达：报价不等于装修总预算"), or a fact plus a short subject that itself comes from the facts ("全厘" +
 * "用于帮助用户梳理…"). Nothing outside the facts' own words can be added.
 */
export function isApprovedClaim(claim: string, approvedFacts: string[]) {
  const said = squash(claim); const facts = approvedFacts.map(squash).filter(Boolean);
  if (!said) return false;
  return facts.some((fact) => {
    if (fact.includes(said)) return true;
    if (!said.includes(fact)) return false;
    const rest = said.replace(fact, "");
    return rest.length <= 8 && facts.some((other) => other.includes(rest));
  });
}

interface ConstraintScope { constraints: DirectorConstraints; approvedFacts: string[]; forbiddenClaims: string[] }

/** Tagged hard-constraint violations of one Shot (tags make the repair message and the statistics unambiguous). */
function constraintViolations(shot: DirectorShot, plan: DirectorPlan, tag: string, scope: ConstraintScope, planLevel: boolean): string[] {
  const { constraints, approvedFacts, forbiddenClaims } = scope;
  const errors: string[] = [];
  const planFields = planLevel ? [plan.title, plan.logline, plan.style, ...plan.characters.map((character) => character.description)] : [];
  // What the video model sees (compiled) plus what the plan says it is about. Dialogue words are speech, not writing.
  const visual = [...planFields, shot.title, shot.purpose, shot.openingState, shot.event, shot.endingState, shot.camera.shotSize, shot.camera.target ?? "", ...shot.invariants, ...shot.visualConstraints];
  const heard = [shot.ambientSound, ...shot.physicalSounds, ...shot.nonVerbalSounds, shot.nonDiegeticMusicIntent ?? ""];
  const clauseHit = (values: string[], ...patterns: RegExp[]) => {
    for (const value of values) for (const clause of affirmativeClauses(value)) for (const pattern of patterns) { const match = clause.match(pattern); if (match) return match[0]; }
    return null;
  };
  if (!constraints.allowDialogue) {
    if (shot.dialogue.length) errors.push(`${tag}：[no_dialogue] 本需求不允许任何对白，但计划了 ${shot.dialogue.length} 句台词`);
    const spoken = clauseHit([...visual, ...heard], SPEECH_EN, SPEECH_ZH);
    if (spoken) errors.push(`${tag}：[no_dialogue] 本需求不允许任何对白，描述里出现了说话 / 旁白“${spoken}”`);
  } else if (!constraints.allowVoiceover) {
    if (shot.dialogue.some((line) => line.voiceover || !line.onScreenSpeaking)) errors.push(`${tag}：[no_voiceover] 本需求不允许旁白 / 画外音，每句台词都必须是画面内开口`);
    const narrated = clauseHit([...visual, ...heard], VOICEOVER);
    if (narrated) errors.push(`${tag}：[no_voiceover] 本需求不允许旁白 / 画外音，描述里出现了“${narrated}”`);
  }
  if (!constraints.allowReadableText) {
    const quoted = [...visual, ...heard].find((value) => QUOTED.test(value));
    if (quoted) errors.push(`${tag}：[no_readable_text] 描述里有引号文字（会被渲染成可读文字）：${quoted.slice(0, 50)}`);
    const readable = clauseHit(visual, READABLE_EN, READABLE_ZH);
    if (readable) errors.push(`${tag}：[no_readable_text] 本需求不生成可读文字（屏幕字、招牌、标签、印章、字幕、海报、纸面 / 包装 / 手机上的字），出现了“${readable}”，请改成人物和物件的动作`);
  }
  if (!constraints.allowGeneratedUI) {
    const ui = clauseHit(visual, UI_EN, UI_ZH);
    if (ui) errors.push(`${tag}：[no_generated_ui] 本需求不生成 App / 小程序 / 仪表盘 / 按钮 / 软件页面 / 手机界面 / 截图（真实界面由后期素材处理），出现了“${ui}”`);
  }
  const everything = [...visual, ...heard, ...shot.dialogue.map((line) => line.text), ...shot.productClaims];
  if (!constraints.allowNumbers) {
    const factTokens = new Set(approvedFacts.flatMap(numberTokens).map((token) => squash(token)));
    const stray = everything.flatMap(numberTokens).find((token) => !factTokens.has(squash(token)));
    if (stray) errors.push(`${tag}：[no_numbers] 出现未经批准的具体金额 / 数字“${stray}”（金额、百分比、折扣、性能、用户数、节省、成交量、评分都只能来自批准事实）`);
  }
  for (const claim of shot.productClaims) if (!isApprovedClaim(claim, approvedFacts)) errors.push(`${tag}：[unapproved_claim] 产品说法“${claim}”不在批准事实里`);
  const said = squash(everything.join("\n"));
  for (const claim of forbiddenClaims) if (squash(claim) && said.includes(squash(claim))) errors.push(`${tag}：[forbidden_claim] 出现了禁止的说法“${claim}”`);
  return errors;
}

// ——— plan checks (what the confirmation screen lists) ———

export type PlanCheckCategory = "structure" | "shots" | "duration" | "readable_text" | "generated_ui" | "dialogue" | "product" | "camera" | "language" | "compile";
export interface PlanIssue { category: PlanCheckCategory; message: string }
export interface PlanCheck { id: PlanCheckCategory; label: string; state: "pass" | "fail" | "skipped"; problems: string[] }

/** Allowed total for a target (30 s → 26–34 s). Each Shot keeps its legal H3 length; nothing is trimmed to hit an exact number. */
export function m2DurationWindow(targetSeconds: number) {
  const slack = Math.max(3, Math.round((targetSeconds * 2) / 15));
  return { min: targetSeconds - slack, max: targetSeconds + slack };
}

const CHECK_LABELS: [PlanCheckCategory, string][] = [
  ["structure", "计划结构合法"], ["shots", `镜头数量合法（${M2_SHOT_COUNT.min}–${M2_SHOT_COUNT.max} 个）`], ["duration", "总时长合理"],
  ["readable_text", "无非法可读文字"], ["generated_ui", "无虚构 UI"], ["dialogue", "对白规则通过"], ["product", "产品事实通过"],
  ["camera", "运镜无冲突"], ["language", "描述字段为英文"], ["compile", "H3 Prompt 编译通过（含预检）"],
];
const TAG_CATEGORY: Record<string, PlanCheckCategory> = { no_dialogue: "dialogue", no_voiceover: "dialogue", no_readable_text: "readable_text", no_generated_ui: "generated_ui", no_numbers: "product", unapproved_claim: "product", forbidden_claim: "product" };

/** Fixed, ordered check list. When the plan did not even parse, only the structure checks are meaningful. */
export function planChecks(result: Pick<DirectorCompileResult, "issues" | "plan">, targetSeconds?: number): PlanCheck[] {
  const window = targetSeconds ? m2DurationWindow(targetSeconds) : null;
  return CHECK_LABELS.map(([id, label]) => {
    const problems = result.issues.filter((issue) => issue.category === id).map((issue) => issue.message);
    const parsedOnly = id === "structure" || id === "shots";
    const state = problems.length ? "fail" : !result.plan && !parsedOnly ? "skipped" : "pass";
    return { id, label: id === "duration" && window ? `总时长合理（${window.min}–${window.max} 秒）` : label, state, problems };
  });
}

/** Validate a model's plan and compile every Shot. Never throws for bad model output: problems come back as categorised issues. */
export function compileDirectorPlan(input: unknown, options: CompileOptions): DirectorCompileResult {
  const issues: PlanIssue[] = []; const warnings: string[] = [];
  const add = (category: PlanCheckCategory, message: string) => { issues.push({ category, message }); };
  const done = (plan: DirectorPlan | null, shots: CompiledDirectorShot[], totalSeconds: number): DirectorCompileResult =>
    ({ ok: issues.length === 0, errors: issues.map((issue) => issue.message), issues, warnings, plan, shots, totalSeconds, compilerVersion: M2_COMPILER_VERSION });
  if (!M2_ASPECTS.includes(options.aspect)) { add("structure", `不支持的画面比例 ${options.aspect}`); return done(null, [], 0); }
  const parsed = DirectorPlanSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(issue.path.length === 1 && issue.path[0] === "shots" ? "shots" : "structure", `${issue.path.join(".") || "计划"}：${issue.message}`);
    return done(null, [], 0);
  }
  const plan = parsed.data;
  const approvedFacts = (options.approvedFacts ?? []).map((fact) => fact.trim()).filter(Boolean);
  const forbiddenClaims = (options.forbiddenClaims ?? []).map((claim) => claim.trim()).filter(Boolean);
  const chineseBrief = options.intent ? HAN.test(options.intent) && !/英文|英语|English/i.test(options.intent) : false;
  const englishFields = (label: string, values: (string | null)[]) => { for (const value of values) if (value && CJK.test(value)) add("language", `${label} 需用英文描述（只有台词、标题、镜头目标可以是中文）：${value.slice(0, 40)}`); };
  englishFields("style", [plan.style]);
  englishFields("characters.description", plan.characters.map((character) => character.description));
  if (new Set(plan.characters.map((character) => character.id)).size !== plan.characters.length) add("structure", "角色 id 重复");
  const scope: ConstraintScope = { constraints: normalizeConstraints(options.constraints), approvedFacts, forbiddenClaims };

  const shots = plan.shots.map((shot, position): CompiledDirectorShot => {
    const index = position + 1;
    const tag = `Shot ${String(index).padStart(2, "0")}`;
    if (shot.index !== index) add("structure", `${tag}：index 应为 ${index}`);
    const length = secondsToH3Length(shot.plannedDurationSeconds);
    const actualSeconds = lengthToSeconds(length);
    const settings = m2Settings(options.aspect, length, options.promptMode);
    // Semantic checks (director layer).
    englishFields(`${tag} 描述`, [shot.openingState, shot.event, shot.endingState, shot.camera.shotSize, shot.camera.target, shot.ambientSound, shot.nonDiegeticMusicIntent, ...shot.invariants, ...shot.physicalSounds, ...shot.nonVerbalSounds, ...shot.visualConstraints, ...shot.dialogue.map((line) => line.delivery)]);
    for (const id of shot.characters) if (!plan.characters.some((character) => character.id === id)) add("structure", `${tag}：角色 ${id} 没有在 characters 里定义`);
    if (shot.forbiddenCameraMotion.includes(shot.camera.motion)) add("camera", `${tag}：机位运动 ${shot.camera.motion} 同时出现在禁止列表里（自相矛盾）`);
    if (shot.allowedCameraMotion.length && !shot.allowedCameraMotion.includes(shot.camera.motion)) add("camera", `${tag}：机位运动 ${shot.camera.motion} 不在允许列表里`);
    if (shot.allowedCameraMotion.some((motion) => shot.forbiddenCameraMotion.includes(motion))) add("camera", `${tag}：同一种运镜既被允许又被禁止`);
    const speakerIds = new Set(shot.dialogue.map((line) => line.speaker));
    if (speakerIds.size > 2) add("dialogue", `${tag}：一个镜头最多两位说话者`);
    else if (speakerIds.size > 1) warnings.push(`${tag}：有两位说话者（建议每镜一个主要说话者）`);
    let chineseChars = 0; let englishWords = 0;
    for (const line of shot.dialogue) {
      if (!shot.characters.includes(line.speaker)) add("dialogue", `${tag}：说话者 ${line.speaker} 不在本镜角色里`);
      if (line.voiceover && line.onScreenSpeaking) add("dialogue", `${tag}：同一句台词不能既是画面内开口又是画外旁白`);
      const han = (line.text.match(HAN_ALL) ?? []).length;
      if (han && line.language !== "Chinese") add("dialogue", `${tag}：台词“${line.text}”是中文，language 应为 Chinese`);
      if (!han && line.language === "Chinese") add("dialogue", `${tag}：台词“${line.text}”不是中文，language 不应为 Chinese`);
      if (chineseBrief && line.language !== "Chinese") add("dialogue", `${tag}：中文需求的台词必须保持中文，不能翻译成 ${line.language}`);
      chineseChars += han; englishWords += han ? 0 : words(line.text);
    }
    const speechSeconds = chineseChars / DIALOGUE_RATE.chineseCharsPerSecond + englishWords / DIALOGUE_RATE.englishWordsPerSecond;
    if (speechSeconds > actualSeconds * 0.8) add("dialogue", `${tag}：台词约需 ${speechSeconds.toFixed(1)} 秒，放不进 ${actualSeconds.toFixed(1)} 秒的镜头`);
    // Hard constraints + product / brand facts (same rules whichever provider wrote the plan).
    for (const message of constraintViolations(shot, plan, tag, scope, position === 0)) add(TAG_CATEGORY[/\[([a-z_]+)\]/.exec(message)?.[1] ?? ""] ?? "product", message);
    // Deterministic compilation (compiler layer).
    const { speakers, fields } = compileT2vaFields(shot, plan, options.aspect, options.subjectAnchor);
    const officialPrompt = assembleOfficialT2va(fields);
    if (options.subjectAnchor) {
      // The anchor is written once by the compiler; a director copying it into its own fields would stack it.
      const times = occurrences(officialPrompt, options.subjectAnchor.subjectDescription);
      if (times !== 1) add("compile", `${tag}：主体描述在 Prompt 中出现了 ${times} 次（应由编译器只写一次，导演不要复述主体外观）`);
      if (options.subjectAnchor.sceneAnchor && occurrences(officialPrompt, options.subjectAnchor.sceneAnchor) !== 1) add("compile", `${tag}：场景锚点在 Prompt 中出现了 ${occurrences(officialPrompt, options.subjectAnchor.sceneAnchor)} 次`);
    }
    // Banned terms must not reach the video model through the compiler's own wording either (e.g. the POV camera sentence).
    for (const claim of forbiddenClaims) if (squash(claim) && squash(officialPrompt).includes(squash(claim))) add("product", `${tag}：[forbidden_claim] 最终 Prompt 中出现了禁止的说法“${claim}”`);
    for (const problem of checkOfficialT2va(fields, shot.dialogue.map((line) => line.text))) add("compile", `${tag}（编译结果）：${problem}`);
    for (const term of shot.forbiddenContent) if (mentions(officialPrompt, term)) add("compile", `${tag}：禁止内容“${term}”出现在画面描述中`);
    const plainPrompt = plainPromptFromShot(shot, options.subjectAnchor);
    const submitPrompt = options.promptMode === "official" ? officialPrompt : plainPrompt;
    const preflight = runH3Preflight({ mode: "t2va", prompt: compileH3Prompt(submitPrompt, settings.soundMode), rawPrompt: submitPrompt, counts: frameModeCounts("t2va"), length, megapixels: settings.megapixels, dimensions: t2vaDimensions(settings) });
    for (const issue of preflight.errors) add("compile", `${tag}：${issue.message}`);
    const shotWarnings = preflight.warnings.map((issue) => issue.message);
    if (Math.abs(actualSeconds - shot.plannedDurationSeconds) >= 0.4) shotWarnings.push(`计划 ${shot.plannedDurationSeconds} 秒 → H3 合法长度 ${length} 帧（${actualSeconds.toFixed(2)} 秒）`);
    warnings.push(...shotWarnings.map((warning) => `${tag}：${warning}`));
    return { index, title: shot.title, semantic: shot, plannedSeconds: shot.plannedDurationSeconds, length, actualSeconds, speakers, compilerVersion: M2_COMPILER_VERSION, officialPrompt, plainPrompt, submitPrompt, source: { plan: "director", prompt: "compiler" }, settings, warnings: shotWarnings };
  });
  const totalSeconds = shots.reduce((sum, shot) => sum + shot.actualSeconds, 0);
  const window = m2DurationWindow(options.targetSeconds);
  if (totalSeconds < window.min || totalSeconds > window.max) add("duration", `镜头总时长 ${totalSeconds.toFixed(1)} 秒与目标 ${options.targetSeconds} 秒相差太大（允许 ${window.min}–${window.max} 秒）`);
  if (shots.some((shot) => shot.length < H3_MIN_LENGTH || shot.length > H3_MAX_LENGTH)) add("compile", "存在超出 H3 合法范围的镜头长度");
  return done(plan, shots, totalSeconds);
}

// ——— content presets (fill the hard constraints; the program, not the model, decides) ———

export const M2_PRESET_IDS = ["general", "spectacle", "character", "product"] as const;
export type M2PresetId = (typeof M2_PRESET_IDS)[number];
export interface M2Preset { id: M2PresetId; label: string; hint: string; constraints: DirectorConstraints; requiresApprovedFacts: boolean }
export const M2_DEFAULT_PRESET: M2PresetId = "general";
export const PRODUCT_FACTS_REQUIRED_MESSAGE = "产品宣传需要先填写已批准的产品事实，避免AI编造功能或数据。";

export const M2_PRESETS: Record<M2PresetId, M2Preset> = {
  general: { id: "general", label: "普通短视频", hint: "保守默认：不生成可读文字和界面，也不写数字", constraints: { ...DEFAULT_DIRECTOR_CONSTRAINTS }, requiresApprovedFacts: false },
  spectacle: { id: "spectacle", label: "无对白奇观", hint: "只有画面和声音：没有台词、旁白、可读文字、界面", constraints: { allowDialogue: false, allowVoiceover: false, allowReadableText: false, allowGeneratedUI: false, allowNumbers: true }, requiresApprovedFacts: false },
  character: { id: "character", label: "角色短剧", hint: "角色可以在画面内说话；没有旁白、可读文字、界面", constraints: { allowDialogue: true, allowVoiceover: false, allowReadableText: false, allowGeneratedUI: false, allowNumbers: false }, requiresApprovedFacts: false },
  product: { id: "product", label: "产品 / 品牌宣传", hint: "只能说已批准的产品事实；不生成数字、可读文字、界面", constraints: { allowDialogue: true, allowVoiceover: true, allowReadableText: false, allowGeneratedUI: false, allowNumbers: false }, requiresApprovedFacts: true },
};
export const isPresetId = (value: unknown): value is M2PresetId => typeof value === "string" && (M2_PRESET_IDS as readonly string[]).includes(value);

const PRODUCT_WORDS = /宣传|广告|品牌|产品|推广|卖点|代言|种草|带货|介绍我们|我们的(工具|服务|软件|平台|App)|\b(ad|brand|product|promo)\b/i;
const CHARACTER_WORDS = /聊|对话|说话|吵架|争论|问答|台词|短剧|剧情|夫妻|情侣|朋友|同事|母女|父子|对白|讲述|吐槽|\b(talk|chat|dialogue|argue)\b/i;
const SPECTACLE_WORDS = /起飞|降落|爆炸|奇观|航拍|风光|风景|延时|飞船|战斗机|飞机|火箭|赛车|追逐|海浪|瀑布|火山|冲向|实拍感|慢动作|\b(spectacle|aerial|timelapse|explosion)\b/i;

/** Keyword suggestion only. It never changes the user's choice or the constraints. */
export function suggestPreset(intent: string): { preset: M2PresetId; reason: string } {
  if (PRODUCT_WORDS.test(intent)) return { preset: "product", reason: `提到了“${PRODUCT_WORDS.exec(intent)![0]}”` };
  if (CHARACTER_WORDS.test(intent)) return { preset: "character", reason: `提到了“${CHARACTER_WORDS.exec(intent)![0]}”` };
  if (SPECTACLE_WORDS.test(intent)) return { preset: "spectacle", reason: `提到了“${SPECTACLE_WORDS.exec(intent)![0]}”，没有对话` };
  return { preset: "general", reason: "没有明显的题材关键词" };
}
