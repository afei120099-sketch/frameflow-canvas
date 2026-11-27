import { ClaudeDirectorProvider } from "./director-claude.ts";
import { LocalLmStudioDirectorProvider } from "./director-lmstudio.ts";
import { loadDirectorRuntimeSkill, type DirectorRuntimeSkill } from "./director-runtime-skill.ts";
import { CAMERA_MOTIONS, m2DurationWindow, M2_PRESETS, M2_SHOT_COUNT, M2_SHOT_SECONDS, normalizeConstraints, type DirectorConstraints, type DirectorPlan, type DirectorShot, type M2Aspect, type SubjectAnchor } from "../lib/autopilot-director.ts";
import { DIRECTOR_PLAN_PACKAGE_VERSION, packageSkeleton, type DirectorPackageRequest } from "../lib/autopilot-package.ts";

/**
 * Autopilot M2 Director Providers. A provider turns one sentence into a semantic DirectorPlan (what to
 * shoot, how to shoot it) and, once, repairs it from the checker's error list. It never writes H3 prompt
 * syntax — the deterministic compiler in lib/autopilot-director.ts does. It knows nothing about jobs,
 * ledgers or ComfyUI; the worker owns all state, limits and ordering.
 *
 * Every provider receives the same DirectorRequest (same brief, same constraints) and every reply goes
 * through the same validator + compiler. No provider has its own rules.
 *
 * Implemented: "mock" (deterministic, tests / pipeline checks), "local-lmstudio" (director-lmstudio.ts),
 * "claude" (director-claude.ts, Anthropic Messages API). Declared but not connected: "openai".
 */

export interface DirectorRequest {
  intent: string;
  targetSeconds: number;
  aspect: M2Aspect;
  /** Product / brand facts the plan may state (nothing else specific). */
  approvedFacts: string[];
  forbiddenClaims: string[];
  /** Hard constraints (also stated in the brief; enforced by the validator). */
  constraints: DirectorConstraints;
  /** User / project Subject Anchor (the compiler writes it; the director only uses the subject). */
  subjectAnchor?: SubjectAnchor | null;
  /** Director Runtime Skill injected at the top of brief.system (version + hash of the injected text). */
  runtimeSkill?: { version: string; hash: string } | null;
  brief: { system: string; user: string };
}

/** Provider-reported usage. costUsd is only set when it can be computed from a verified price list. */
export interface DirectorUsage {
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number;
  cacheCreationInputTokens?: number; cacheReadInputTokens?: number;
  costUsd?: number; costBasis?: string; durationMs?: number; stopReason?: string | null;
}

/** One HTTP exchange inside a provider call (retries included). Never contains keys, URLs or bodies. */
export interface DirectorTransportRecord { at: string; status: number | null; error: string | null; durationMs: number; requestId: string | null; retryAfterSeconds: number | null; retried: boolean }

/** Worst case of one call, recorded before the call is made. */
export interface DirectorCallBudget { maxInputTokens: number | null; maxOutputTokens: number; maxCostUsd: number | null; costBasis: string }

export interface DirectorCallResult {
  text: string;
  model: string;
  usage?: DirectorUsage;
  transport?: DirectorTransportRecord[];
}

export interface DirectorProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: "mock" | "local" | "cloud";
  /** True when the model runs on this PC's GPU and must be unloaded before H3 production. */
  readonly usesLocalGpu: boolean;
  available(): { ok: boolean; reason?: string };
  plan(request: DirectorRequest, options: { signal: AbortSignal }): Promise<DirectorCallResult>;
  repair(request: DirectorRequest, previous: string, problems: string[], options: { signal: AbortSignal }): Promise<DirectorCallResult>;
  /**
   * Free GPU memory (local providers). Must succeed before the first H3 Shot is submitted. Throws an
   * Error with code "local_director_resource_conflict" when another task may be using the model.
   */
  release?(): Promise<DirectorReleaseReport | void>;
  /** Upper bound of the next call (tokens, and money when priced), recorded before it is made. */
  callBudget?(request: DirectorRequest, kind: "plan" | "repair", previous?: string): DirectorCallBudget;
  /** Implementation version, recorded with every call. */
  readonly version?: string;
}

export interface DirectorReleaseReport { unloaded: string[]; gpuUsedBeforeMiB: number | null; gpuUsedAfterMiB: number | null; gpuTotalMiB: number | null; freeAfterMiB: number | null }
export const RESOURCE_CONFLICT = "local_director_resource_conflict";

export interface DirectorProviderInfo { id: string; label: string; kind: DirectorProvider["kind"]; usesLocalGpu: boolean; available: boolean; reason: string | null }
export const describeProvider = (provider: DirectorProvider): DirectorProviderInfo => {
  const state = provider.available();
  return { id: provider.id, label: provider.label, kind: provider.kind, usesLocalGpu: provider.usesLocalGpu, available: state.ok, reason: state.ok ? null : state.reason ?? "不可用" };
};

/**
 * One brief for every provider:
 *   system = Director Runtime Skill (fixed planning rules from Director SKILL 2.0)
 *          + this request's hard constraints, Subject Anchor, approved facts, forbidden claims
 *          + the semantic JSON field contract (no H3 prompt syntax is ever asked for)
 *   user   = the user's sentence + target duration + aspect
 * Without an explicit skill the default file is loaded, so tests / mock / cloud providers see the same rules.
 */
export function buildDirectorBrief(input: { intent: string; targetSeconds: number; aspect: M2Aspect; approvedFacts?: string[]; forbiddenClaims?: string[]; constraints?: Partial<DirectorConstraints>; subjectAnchor?: SubjectAnchor | null; runtimeSkill?: DirectorRuntimeSkill | null; output?: "plan" | "package" }): DirectorRequest["brief"] {
  const skill = input.runtimeSkill ?? loadDirectorRuntimeSkill();
  const facts = input.approvedFacts?.filter((fact) => fact.trim()) ?? [];
  const forbidden = input.forbiddenClaims?.filter((claim) => claim.trim()) ?? [];
  const rules = normalizeConstraints(input.constraints);
  const dialogueRule = !rules.allowDialogue
    ? "Dialogue: NOT allowed in this video. Every shot has an empty dialogue list, and no field may describe anyone saying, talking, chatting, shouting, narrating, a voiceover or radio chatter. Tell the story with action, physical sounds and ambience."
    : `Dialogue: only when the sentence implies speaking; spectacle or ambience-only requests have an empty dialogue list. When characters are asked to chat, give most shots one short line from one speaker, alternating speakers. text is ONLY the spoken words in their original language — no markup, no tags, no speaker ids, no brackets. language is "Chinese" or "English" matching the words; a Chinese request keeps Chinese lines (never translate). Keep lines short enough to speak inside the shot (about 4 Chinese characters per second). speaker is a character id from characters. ${rules.allowVoiceover ? "voiceover=true only for narration heard over the picture." : "No voiceover or narration: every line is spoken on screen by a visible character (onScreenSpeaking=true, voiceover=false)."}`;
  const numbersRule = rules.allowNumbers
    ? "Numbers may appear where the sentence naturally needs them (speed, distance, time), but never invent prices, product statistics or claims."
    : "No numbers: no digits and no number words for amounts, prices, percentages, discounts, performance, user counts, savings, deal counts or ratings (anywhere, dialogue included) unless an approved fact below states that exact number.";
  const system = [
    skill.text,
    "# This request (hard constraints checked by a program; a plan that breaks one is rejected)",
    `Plan ${M2_SHOT_COUNT.min}-${M2_SHOT_COUNT.max} shots, each ${M2_SHOT_SECONDS.min}-${M2_SHOT_SECONDS.max} seconds (plannedDurationSeconds), total about ${input.targetSeconds} seconds, aspect ${input.aspect}. Every shot is generated as its own single continuous take from text only (no reference images, no cuts inside a shot). You only fill in the JSON fields.`,
    `Camera fields: exactly one camera.motion from ${CAMERA_MOTIONS.join(", ")}; amplitude small/medium/large; speed slow/normal/fast; shotSize like "medium shot" or "wide shot"; target is what the camera moves toward or follows (or null). allowedCameraMotion must include camera.motion; list incompatible motions in forbiddenCameraMotion.`,
    "Language: title, purpose and dialogue text may be Chinese. EVERY other descriptive field (style, character description, openingState, event, endingState, shotSize, target, delivery, invariants, sounds, music intent, visualConstraints) must be written in English sentences.",
    dialogueRule,
    "Sound: ambientSound (English sentence), physicalSounds (action sounds), nonVerbalSounds (breathing, laughter, barks — never speech). nonDiegeticMusicIntent describes background music only the audience hears (instrumentation, tempo, dynamics) or null for none.",
    rules.allowReadableText
      ? "Readable text: allowed only where the sentence needs it; keep it minimal."
      : "No readable text: no on-screen text, captions, subtitles, title cards, signs, labels, stamps, posters, price tags, charts or legible writing on paper, packages or phones; such things are added in post-production. Paper, boxes and phones may appear, but never describe what is written on them, and never put words in quotation marks.",
    ...(rules.allowGeneratedUI ? [] : ["No generated software: no apps, mini-programs, dashboards, buttons, icons, pop-ups, software pages, phone or computer screens showing an interface, or fake product screenshots. Real product interfaces are added later from real recordings; show people, hands and physical objects instead."]),
    numbersRule,
    "Anything that must not appear goes into forbiddenContent only; do not mention it in the other fields (not even as \"no …\").",
    facts.length
      ? `Product / brand facts you may use (and only these): ${facts.map((fact) => `「${fact}」`).join(" ")}. Put each fact a shot conveys, verbatim, in that shot's productClaims. Do not invent other features, prices, discounts, numbers, data, customer cases or performance claims.`
      : "No product facts were approved: do not state specific product features, prices, numbers or claims; productClaims stays empty.",
    ...(forbidden.length ? [`Never say or show: ${forbidden.map((claim) => `「${claim}」`).join(" ")}.`] : []),
    ...(input.subjectAnchor ? [`Fixed main subject (decided by the user, written into every shot by the program): ${input.subjectAnchor.subjectDescription}.${input.subjectAnchor.sceneAnchor ? ` Fixed scene base: ${input.subjectAnchor.sceneAnchor}.` : ""} You decide only what the subject does in each shot. Do not redefine what it is or describe its appearance again; refer to it with a short noun (for example "the ${shortNoun(input.subjectAnchor.subjectDescription)}"). Keep the scene base consistent with it.`] : []),
    input.output === "package" ? PACKAGE_CONTRACT : PLAN_CONTRACT,
  ].join("\n\n");
  return { system, user: `用户的一句话需求：${input.intent}\n目标时长：约 ${input.targetSeconds} 秒；画面比例：${input.aspect}` };
}

/** Output contract of the local / API director (a bare DirectorPlan). */
const PLAN_CONTRACT = "JSON fields: {title, logline, style (English, e.g. \"Live-action, handheld smartphone footage\"), characters:[{id, name, description (English noun phrase)}], shots:[{index (1..n), title, purpose, plannedDurationSeconds, openingState, event, endingState, characters:[ids], camera:{shotSize, motion, amplitude, speed, target}, allowedCameraMotion:[], forbiddenCameraMotion:[], invariants:[], dialogue:[{speaker, text, language, delivery, onScreenSpeaking, voiceover}], ambientSound, physicalSounds:[], nonVerbalSounds:[], nonDiegeticMusicIntent, visualConstraints:[], forbiddenContent:[], productClaims:[]}]}.";
/** Output contract of an external director (chat window today, API later): the same shot fields inside a package. */
const PACKAGE_CONTRACT = `Output: one JSON object in the ${DIRECTOR_PLAN_PACKAGE_VERSION} format shown at the end. Copy packageVersion, project (except title), constraints, subjectAnchor, approvedFacts and forbiddenClaims exactly as given; fill in project.title and plan. plan = {summary (one sentence), style (English, e.g. "Live-action, handheld smartphone footage"), characters:[{id, name, description (English noun phrase)}], shots:[{index (1..n), title, purpose, plannedDurationSeconds, openingState, event, endingState, characters:[ids], camera:{shotSize, motion, amplitude, speed, target}, allowedCameraMotion:[], forbiddenCameraMotion:[], invariants:[], dialogue:[{speaker, text, language, delivery, onScreenSpeaking, voiceover}], ambientSound, physicalSounds:[], nonVerbalSounds:[], nonDiegeticMusicIntent, visualConstraints:[], forbiddenContent:[], productClaims:[]}]}. Use no other fields.`;

/**
 * 【复制给GPT / Claude】: the same Runtime Skill + request rules the local director gets, the request as a
 * pre-filled package skeleton, and the output rule. The chat model plans semantics only; the local compiler
 * still writes every H3 prompt.
 */
export function buildExternalDirectorTask(request: DirectorPackageRequest, runtimeSkill?: DirectorRuntimeSkill | null) {
  const skill = runtimeSkill ?? loadDirectorRuntimeSkill();
  const window = m2DurationWindow(request.targetDurationSeconds);
  const preset = M2_PRESETS[request.preset];
  const brief = buildDirectorBrief({
    intent: request.brief, targetSeconds: request.targetDurationSeconds, aspect: request.aspectRatio, approvedFacts: request.approvedFacts,
    forbiddenClaims: [...request.forbiddenClaims, ...request.constraints.forbiddenTerms], constraints: request.constraints, subjectAnchor: request.subjectAnchor, runtimeSkill: skill, output: "package",
  });
  const text = [
    `你是这条 AI 短视频的导演。请遵守下面的导演规则和本次需求，只输出一个 Director Plan Package（${DIRECTOR_PLAN_PACKAGE_VERSION}）。`,
    `【一句话需求】${request.brief}\n【目标总时长】约 ${request.targetDurationSeconds} 秒（所有镜头合计 ${window.min}–${window.max} 秒）\n【画面比例】${request.aspectRatio}\n【题材预设】${preset.label}（${preset.id}）：${preset.hint}`,
    brief.system,
    `# Package to return (fill in project.title and plan; copy everything else unchanged)\n${JSON.stringify(packageSkeleton(request), null, 2)}`,
    "只返回 Director Plan JSON，不要解释，不要Markdown代码围栏。",
  ].join("\n\n");
  return { text, runtimeSkill: { version: skill.version, hash: skill.hash } };
}

/** "a realistic gray modern VTOL fighter jet with …" → "fighter jet": the words before the first "with / that / on / in". */
function shortNoun(description: string) {
  const head = description.split(/\s+(?:with|that|which|on|in|carrying|featuring)\s+|,/i)[0].replace(/^(a|an|the)\s+/i, "").trim().split(/\s+/);
  return head.slice(-2).join(" ") || "subject";
}

// ——— mock (tests / pipeline checks; not a real director) ———

const MOCK_BEATS: Pick<DirectorShot, "title" | "purpose" | "openingState" | "event" | "endingState" | "camera">[] = [
  { title: "开场建立", purpose: "交代环境和主体", openingState: "The subject stands in the center of a bright, tidy living room.", event: "The subject takes one small step toward the camera and stops.", endingState: "The subject looks straight ahead, calm and still.", camera: { shotSize: "medium shot", motion: "static", amplitude: "medium", speed: "normal", target: null } },
  { title: "动作推进", purpose: "主体完成一个主要动作", openingState: "The subject stands still near the sofa.", event: "The subject turns and walks toward the window on the right side of the frame.", endingState: "The subject stops beside the window.", camera: { shotSize: "medium shot", motion: "truck_right", amplitude: "small", speed: "slow", target: "the subject" } },
  { title: "反应", purpose: "主体对变化做出反应", openingState: "The subject stands beside the window.", event: "The subject lifts its head and gazes outside with a focused expression.", endingState: "The subject keeps gazing outside.", camera: { shotSize: "close shot", motion: "push_in", amplitude: "small", speed: "slow", target: "the subject's face" } },
  { title: "细节", purpose: "展示一个关键细节", openingState: "A small detail on the table fills the frame.", event: "Sunlight slowly moves across the tabletop.", endingState: "The light settles in a warm patch.", camera: { shotSize: "close-up", motion: "static", amplitude: "medium", speed: "normal", target: null } },
  { title: "转折", purpose: "节奏发生变化", openingState: "The subject returns to the center of the room.", event: "The subject makes one clear responsive gesture.", endingState: "The subject pauses.", camera: { shotSize: "medium shot", motion: "static", amplitude: "medium", speed: "normal", target: null } },
  { title: "收尾", purpose: "给出结尾画面", openingState: "The subject faces the camera in the middle of the room.", event: "The subject sits down calmly.", endingState: "The scene settles into a stable closing composition.", camera: { shotSize: "medium-wide shot", motion: "pull_out", amplitude: "small", speed: "slow", target: null } },
];

/** Deterministic semantic plan from the sentence length only. Clearly labelled; its content is generic by design. */
export function mockPlan(intent: string, targetSeconds: number): DirectorPlan {
  const count = Math.min(M2_SHOT_COUNT.max, Math.max(M2_SHOT_COUNT.min, Math.round(targetSeconds / 7.5)));
  const seconds = Math.min(M2_SHOT_SECONDS.max, Math.max(M2_SHOT_SECONDS.min, Math.round((targetSeconds / count) * 2) / 2));
  const beats = count >= MOCK_BEATS.length ? MOCK_BEATS : [...MOCK_BEATS.slice(0, count - 1), MOCK_BEATS.at(-1)!];
  return {
    title: "Mock 导演计划（测试用）",
    logline: intent.slice(0, 200),
    style: "Live-action, cinematic",
    characters: [{ id: "subject", name: "主体", description: "a calm person in a light gray sweater" }],
    shots: beats.map((beat, position) => ({
      index: position + 1, title: beat.title, purpose: `${beat.purpose}（需求：${intent.slice(0, 60)}）`, plannedDurationSeconds: seconds,
      openingState: beat.openingState, event: beat.event, endingState: beat.endingState, characters: ["subject"], camera: { ...beat.camera },
      allowedCameraMotion: [beat.camera.motion], forbiddenCameraMotion: beat.camera.motion === "static" ? ["push_in", "pan_left", "pan_right"] : ["static"],
      invariants: ["the subject's appearance", "the room layout"], dialogue: [],
      ambientSound: "Quiet indoor room tone continues throughout.", physicalSounds: ["soft footsteps", "light fabric movement"], nonVerbalSounds: [],
      nonDiegeticMusicIntent: null, visualConstraints: ["Soft daylight fills the room."], forbiddenContent: ["logo"], productClaims: [],
    })),
  };
}

export class MockDirectorProvider implements DirectorProvider {
  readonly id = "mock";
  readonly label = "Mock 导演（测试用，不是真实导演模型）";
  readonly kind = "mock" as const;
  readonly usesLocalGpu = false;
  readonly version = "mock-director-v2";
  available() { return { ok: true }; }
  async plan(request: DirectorRequest, options: { signal: AbortSignal }) {
    if (options.signal.aborted) throw new DOMException("导演规划已取消", "AbortError");
    return { text: JSON.stringify(mockPlan(request.intent, request.targetSeconds), null, 2), model: "mock-director-v2" };
  }
  async repair(request: DirectorRequest, _previous: string, _problems: string[], options: { signal: AbortSignal }) { return this.plan(request, options); }
}

/** A provider slot that exists in the interface but is not wired yet (no network code, no key read). */
export class PendingDirectorProvider implements DirectorProvider {
  readonly id: string; readonly label: string; readonly kind: "local" | "cloud"; readonly usesLocalGpu: boolean;
  constructor(id: string, label: string, kind: "local" | "cloud", usesLocalGpu: boolean) { this.id = id; this.label = label; this.kind = kind; this.usesLocalGpu = usesLocalGpu; }
  available() { return { ok: false, reason: "待接入：真实导演模型在 M2 代码完成后单独接入并验收" }; }
  async plan(): Promise<DirectorCallResult> { throw new Error(`${this.label} 尚未接入`); }
  async repair(): Promise<DirectorCallResult> { throw new Error(`${this.label} 尚未接入`); }
}

export function defaultDirectorProviders(): DirectorProvider[] {
  return [
    new MockDirectorProvider(),
    // Anthropic Messages API. Model / effort / limits from config/director-providers.json; key only from ANTHROPIC_API_KEY.
    new ClaudeDirectorProvider(),
    new PendingDirectorProvider("openai", "OpenAI（云端，待接入）", "cloud", false),
    // Real local director (LM Studio). URL / model overridable; a token only if the server requires one.
    new LocalLmStudioDirectorProvider({ baseUrl: process.env.FRAMEFLOW_LMSTUDIO_URL, model: process.env.FRAMEFLOW_LMSTUDIO_MODEL, apiToken: process.env.FRAMEFLOW_LMSTUDIO_TOKEN }),
  ];
}
