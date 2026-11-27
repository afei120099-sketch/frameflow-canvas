import { parseH3Dialogue } from "../h3-dialogue.ts";
import { MEDIA_NAME_PATTERN, OPEN_TASK_STATES, PRODUCTION_SCHEMA, type Aspect, type Episode, type KeyframeSettings, type RoleSpec, type ShotSpec, type StageKind, type Task, type Version, type VideoSettings } from "./types.ts";

/**
 * Pure episode operations: parse the import JSON, create tasks, gate stages, record decisions.
 * No I/O here — the worker persists whatever these functions return.
 */

export const PRODUCTION_LIMITS = { shots: 80, roles: 12, candidates: 6, appearance: 4 } as const;
const H3_MIN_SECONDS = 5, H3_MAX_SECONDS = 15;

function oneLine(value: string) { return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim(); }
function text(value: unknown, where: string, max: number, allowEmpty = false) {
  if (value === undefined && allowEmpty) return "";
  if (typeof value !== "string") throw new Error(`${where} 必须是字符串`);
  const line = value.trim();
  if ((!line && !allowEmpty) || line.length > max) throw new Error(`${where} 需要 ${allowEmpty ? 0 : 1}–${max} 个字符`);
  return line;
}
function media(value: unknown, where: string) {
  const name = text(value, where, 120);
  if (!MEDIA_NAME_PATTERN.test(name)) throw new Error(`${where}「${name}」不是可用的素材文件名（只用字母、数字、中文、空格和 ._-()，扩展名 png/jpg/webp/wav/mp3/flac/m4a）`);
  return name;
}
function num(value: unknown, where: string, min: number, max: number, fallback: number, integer = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${where} 需在 ${min}–${max} 之间${integer ? "的整数" : ""}`);
  return value;
}
function only(record: Record<string, unknown>, allowed: string[], where: string) {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${where} 不认识字段 ${extra.join("、")}。可用：${allowed.join("、")}`);
}
function object(value: unknown, where: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} 必须是对象`);
  return value as Record<string, unknown>;
}

export interface EpisodeDefinition { title: string; aspect: Aspect; roles: RoleSpec[]; shots: ShotSpec[]; keyframe: KeyframeSettings; video: VideoSettings }

/** The import format. Every media field names a file uploaded into the episode's inputs folder. */
export function parseEpisodeDefinition(raw: string): EpisodeDefinition {
  if (raw.length > 1_000_000) throw new Error("剧集定义过大");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("剧集定义不是合法 JSON"); }
  const root = object(value, "剧集定义");
  only(root, ["version", "title", "aspect", "roles", "keyframe", "video", "shots"], "剧集定义");
  if (root.version !== PRODUCTION_SCHEMA) throw new Error(`version 必须是 ${PRODUCTION_SCHEMA}`);
  const title = text(root.title, "title", 80);
  const aspect = root.aspect === undefined ? "9:16" : root.aspect;
  if (aspect !== "9:16" && aspect !== "16:9") throw new Error("aspect 只能是 9:16 或 16:9");

  if (!Array.isArray(root.roles ?? [])) throw new Error("roles 必须是数组");
  const rolesRaw = (root.roles ?? []) as unknown[];
  if (rolesRaw.length > PRODUCTION_LIMITS.roles) throw new Error(`roles 最多 ${PRODUCTION_LIMITS.roles} 个`);
  const roles: RoleSpec[] = rolesRaw.map((item, index) => {
    const where = `roles 第 ${index + 1} 个`;
    const record = object(item, where);
    only(record, ["key", "name", "face", "appearance", "voice", "description"], where);
    const key = text(record.key, `${where}.key`, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`${where}.key 只用字母、数字、_ 和 -`);
    const appearance = record.appearance === undefined ? [] : record.appearance;
    if (!Array.isArray(appearance) || appearance.length > PRODUCTION_LIMITS.appearance) throw new Error(`${where}.appearance 需要 0–${PRODUCTION_LIMITS.appearance} 张`);
    const voice = record.voice === undefined || record.voice === null ? null : media(record.voice, `${where}.voice`);
    if (voice && !/\.(wav|mp3|flac|m4a)$/i.test(voice)) throw new Error(`${where}.voice 需要声音文件（wav/mp3/flac/m4a）`);
    return { key, name: text(record.name ?? key, `${where}.name`, 40), face: record.face === undefined || record.face === null ? null : media(record.face, `${where}.face`), appearance: appearance.map((name, at) => media(name, `${where}.appearance 第 ${at + 1} 张`)), voice, description: text(record.description ?? "", `${where}.description`, 400, true) };
  });
  const roleKeys = new Set<string>();
  for (const role of roles) { if (roleKeys.has(role.key)) throw new Error(`角色 key「${role.key}」重复`); roleKeys.add(role.key); }

  const kf = object(root.keyframe ?? {}, "keyframe");
  only(kf, ["look", "depthStrength", "candidates", "autoApproveAbove"], "keyframe");
  const keyframe: KeyframeSettings = {
    look: oneLine(text(kf.look, "keyframe.look", 600, true)),
    depthStrength: num(kf.depthStrength, "keyframe.depthStrength", 0.3, 1.5, 1),
    candidates: num(kf.candidates, "keyframe.candidates", 1, PRODUCTION_LIMITS.candidates, 3, true),
    autoApproveAbove: kf.autoApproveAbove === undefined || kf.autoApproveAbove === null ? null : num(kf.autoApproveAbove, "keyframe.autoApproveAbove", 0.3, 0.95, 0.6),
  };
  const vd = object(root.video ?? {}, "video");
  only(vd, ["workflow", "tuning", "soundMode", "megapixels", "candidates"], "video");
  if (vd.workflow !== undefined && vd.workflow !== "ultimate") throw new Error("video.workflow 目前只支持 ultimate");
  if (vd.tuning !== undefined && vd.tuning !== "default" && vd.tuning !== "understanding") throw new Error("video.tuning 只能是 default 或 understanding");
  if (vd.soundMode !== undefined && !["av", "ambient", "silent"].includes(vd.soundMode as string)) throw new Error("video.soundMode 只能是 av / ambient / silent");
  const video: VideoSettings = {
    workflow: "ultimate",
    tuning: (vd.tuning as VideoSettings["tuning"]) ?? "default",
    soundMode: (vd.soundMode as VideoSettings["soundMode"]) ?? "av",
    megapixels: num(vd.megapixels, "video.megapixels", 0.3, 1, 0.5),
    candidates: num(vd.candidates, "video.candidates", 1, PRODUCTION_LIMITS.candidates, 1, true),
  };

  if (!Array.isArray(root.shots) || root.shots.length < 1 || root.shots.length > PRODUCTION_LIMITS.shots) throw new Error(`shots 需要 1–${PRODUCTION_LIMITS.shots} 镜`);
  const seen = new Set<string>();
  const shots: ShotSpec[] = root.shots.map((item, index) => {
    const where = `shots 第 ${index + 1} 镜`;
    const record = object(item, where);
    only(record, ["shotId", "title", "storyboard", "faceRole", "faceWeight", "keyframePrompt", "videoPrompt", "roles", "seconds", "seed", "dialogue", "voiceRole", "offscreen"], where);
    const shotId = text(record.shotId, `${where}.shotId`, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(shotId)) throw new Error(`${where}.shotId 只用字母、数字、_ 和 -`);
    if (seen.has(shotId)) throw new Error(`${where}.shotId「${shotId}」重复`);
    seen.add(shotId);
    const shotRoles = record.roles === undefined ? [] : record.roles;
    if (!Array.isArray(shotRoles)) throw new Error(`${where}.roles 必须是数组`);
    for (const key of shotRoles) if (typeof key !== "string" || !roleKeys.has(key)) throw new Error(`${where}.roles 里的「${String(key)}」不在 roles 中`);
    const faceRole = record.faceRole === undefined || record.faceRole === null ? null : text(record.faceRole, `${where}.faceRole`, 40);
    if (faceRole && !roleKeys.has(faceRole)) throw new Error(`${where}.faceRole「${faceRole}」不在 roles 中`);
    if (faceRole && !roles.find((role) => role.key === faceRole)?.face) throw new Error(`${where}.faceRole「${faceRole}」没有 face 图`);
    let seed: number | null = null;
    if (record.seed !== undefined && record.seed !== null) {
      if (!Number.isSafeInteger(record.seed) || (record.seed as number) < 0) throw new Error(`${where}.seed 需为非负整数`);
      seed = record.seed as number;
    }
    const dialogue = parseH3Dialogue(record.dialogue, shotRoles as string[], `${where}.dialogue`);
    for (const line of dialogue) if (line.voice && line.voice !== "none") media(line.voice.slice("audio:".length), `${where}.dialogue 的 voice`);
    if (dialogue.length && video.soundMode !== "av") throw new Error(`${where} 有台词，video.soundMode 必须是 av`);
    const voiceRole = record.voiceRole === undefined || record.voiceRole === null ? null : text(record.voiceRole, `${where}.voiceRole`, 40);
    if (voiceRole && !(shotRoles as string[]).includes(voiceRole)) throw new Error(`${where}.voiceRole 必须在这一镜的 roles 里`);
    const offscreen = record.offscreen === undefined ? [] : record.offscreen;
    if (!Array.isArray(offscreen) || offscreen.some((key) => typeof key !== "string" || !(shotRoles as string[]).includes(key))) throw new Error(`${where}.offscreen 只能写这一镜 roles 里的角色`);
    const keyframePrompt = oneLine(text(record.keyframePrompt, `${where}.keyframePrompt`, 800, true));
    if (!keyframePrompt && !keyframe.look) throw new Error(`${where} 没有 keyframePrompt，keyframe.look 也是空的`);
    return {
      shotId,
      title: text(record.title ?? shotId, `${where}.title`, 80),
      // Optional: without a storyboard the keyframe is drawn from keyframePrompt alone (no depth map).
      storyboard: record.storyboard === undefined || record.storyboard === null || record.storyboard === "" ? null : media(record.storyboard, `${where}.storyboard`),
      faceRole,
      faceWeight: num(record.faceWeight, `${where}.faceWeight`, 0, 1.5, 0.85),
      keyframePrompt,
      videoPrompt: text(record.videoPrompt, `${where}.videoPrompt`, 12000),
      roles: shotRoles as string[],
      dialogue,
      voiceRole,
      offscreen: offscreen as string[],
      seconds: num(record.seconds, `${where}.seconds`, H3_MIN_SECONDS, H3_MAX_SECONDS, 6),
      seed,
    };
  });
  return { title, aspect, roles, shots, keyframe, video };
}

/** Every media file the episode needs, deduplicated, in first-use order. */
export function requiredMedia(definition: Pick<EpisodeDefinition, "roles" | "shots">) {
  const names: string[] = [];
  const add = (name: string | null) => { if (name && !names.includes(name)) names.push(name); };
  for (const shot of definition.shots) add(shot.storyboard ?? null);
  for (const role of definition.roles) { add(role.face); role.appearance.forEach(add); add(role.voice); }
  for (const shot of definition.shots) for (const line of shot.dialogue) if (line.voice && line.voice !== "none") add(line.voice.slice("audio:".length));
  return names;
}

export function createEpisode(definition: EpisodeDefinition, episodeId: string, at: string): Episode {
  return { schema: PRODUCTION_SCHEMA, episodeId, ...definition, tasks: [], versions: [], paused: false, createdAt: at, updatedAt: at, log: [{ at, action: "created", detail: `${definition.shots.length} 镜` }] };
}

export interface Ids { taskId: () => string; seed: () => number }

const openTasks = (episode: Episode, shotId: string, stage: StageKind) => episode.tasks.filter((task) => task.shotId === shotId && task.stage === stage && OPEN_TASK_STATES.includes(task.state));
export const approvedVersion = (episode: Episode, shotId: string, stage: StageKind) => episode.versions.find((version) => version.shotId === shotId && version.stage === stage && version.status === "approved") ?? null;

function newTask(stage: StageKind, shotId: string, seed: number, taskId: string, at: string, sourceVersionId: string | null): Task {
  return { taskId, stage, shotId, seed, state: "pending", sourceVersionId, attempts: [], retries: 0, error: null, createdAt: at, startedAt: null, completedAt: null, versionId: null };
}

/**
 * Queue keyframe candidates. Default: only shots without an approved keyframe and without open work.
 * `count` overrides the episode's candidate number (retake of one shot).
 */
export function enqueueKeyframes(episode: Episode, ids: Ids, at: string, options: { shotIds?: string[]; count?: number } = {}) {
  const targets = options.shotIds ?? episode.shots.map((shot) => shot.shotId);
  const created: Task[] = [];
  for (const shotId of targets) {
    const shot = episode.shots.find((item) => item.shotId === shotId);
    if (!shot) throw new Error(`没有镜头 ${shotId}`);
    if (!options.shotIds && (approvedVersion(episode, shotId, "keyframe") || openTasks(episode, shotId, "keyframe").length)) continue;
    const count = options.count ?? episode.keyframe.candidates;
    for (let n = 0; n < count; n += 1) {
      // A fixed seed reproduces only the first candidate; the rest vary from it.
      const seed = shot.seed !== null ? shot.seed + n : ids.seed();
      created.push(newTask("keyframe", shotId, seed, ids.taskId(), at, null));
    }
  }
  episode.tasks.push(...created);
  if (created.length) episode.log.push({ at, action: "enqueue_keyframes", detail: `${created.length} 张` });
  return created;
}

/** Queue videos only for shots whose keyframe is approved (the stage gate). */
export function enqueueVideos(episode: Episode, ids: Ids, at: string, options: { shotIds?: string[]; count?: number } = {}) {
  const targets = options.shotIds ?? episode.shots.map((shot) => shot.shotId);
  const created: Task[] = [];
  const skipped: string[] = [];
  for (const shotId of targets) {
    const shot = episode.shots.find((item) => item.shotId === shotId);
    if (!shot) throw new Error(`没有镜头 ${shotId}`);
    const keyframe = approvedVersion(episode, shotId, "keyframe");
    if (!keyframe) { skipped.push(shotId); continue; }
    if (!options.shotIds && (approvedVersion(episode, shotId, "video") || openTasks(episode, shotId, "video").length)) continue;
    const count = options.count ?? episode.video.candidates;
    for (let n = 0; n < count; n += 1) created.push(newTask("video", shotId, shot.seed !== null ? shot.seed + n : ids.seed(), ids.taskId(), at, keyframe.versionId));
  }
  episode.tasks.push(...created);
  if (created.length) episode.log.push({ at, action: "enqueue_videos", detail: `${created.length} 条` });
  return { created, skipped };
}

/** Approve one version; any other approved version of the same shot and stage goes back to candidate. */
export function decideVersion(episode: Episode, versionId: string, decision: "approved" | "rejected" | "candidate", at: string, note = "") {
  const version = episode.versions.find((item) => item.versionId === versionId);
  if (!version) throw new Error("没有这个版本");
  if (decision === "approved") {
    for (const other of episode.versions) if (other !== version && other.shotId === version.shotId && other.stage === version.stage && other.status === "approved") { other.status = "candidate"; other.decidedAt = at; }
  }
  version.status = decision;
  version.decidedAt = at;
  if (note) version.note = note.slice(0, 400);
  episode.log.push({ at, action: `version_${decision}`, shotId: version.shotId, detail: `${version.stage} ${versionId}` });
  return version;
}

/** Keyframe auto-approval: the best face score at or above the threshold, once a shot's candidates are all done. */
export function autoApproveKeyframes(episode: Episode, at: string) {
  const threshold = episode.keyframe.autoApproveAbove;
  if (threshold === null) return [] as Version[];
  const approved: Version[] = [];
  for (const shot of episode.shots) {
    if (approvedVersion(episode, shot.shotId, "keyframe") || openTasks(episode, shot.shotId, "keyframe").length) continue;
    const candidates = episode.versions.filter((version) => version.shotId === shot.shotId && version.stage === "keyframe" && version.status === "candidate");
    // Shots without an identity lock have nothing to measure: they always wait for a person.
    if (!shot.faceRole || !candidates.length) continue;
    const best = candidates.filter((version) => typeof version.score?.face === "number" && (version.score.face as number) >= threshold).sort((a, b) => (b.score!.face as number) - (a.score!.face as number))[0];
    if (best) approved.push(decideVersion(episode, best.versionId, "approved", at, `自动通过：人脸相似度 ${(best.score!.face as number).toFixed(2)} ≥ ${threshold}`));
  }
  return approved;
}

export function cancelOpenTasks(episode: Episode, at: string, filter: (task: Task) => boolean = () => true) {
  const cancelled: Task[] = [];
  for (const task of episode.tasks) {
    if (task.state !== "pending" || !filter(task)) continue;
    task.state = "cancelled"; task.completedAt = at; task.error = "用户取消（未提交）";
    cancelled.push(task);
  }
  if (cancelled.length) episode.log.push({ at, action: "cancel_pending", detail: `${cancelled.length} 个` });
  return cancelled;
}

export type ShotStage = "storyboard" | "keyframe_running" | "keyframe_review" | "keyframe_approved" | "video_running" | "video_review" | "done";

export function shotStage(episode: Episode, shotId: string): ShotStage {
  if (approvedVersion(episode, shotId, "video")) return "done";
  if (openTasks(episode, shotId, "video").length) return "video_running";
  if (episode.versions.some((version) => version.shotId === shotId && version.stage === "video" && version.status === "candidate")) return "video_review";
  if (approvedVersion(episode, shotId, "keyframe")) return "keyframe_approved";
  if (openTasks(episode, shotId, "keyframe").length) return "keyframe_running";
  if (episode.versions.some((version) => version.shotId === shotId && version.stage === "keyframe" && version.status === "candidate")) return "keyframe_review";
  return "storyboard";
}

export function episodeSummary(episode: Episode) {
  const stages: Record<ShotStage, number> = { storyboard: 0, keyframe_running: 0, keyframe_review: 0, keyframe_approved: 0, video_running: 0, video_review: 0, done: 0 };
  for (const shot of episode.shots) stages[shotStage(episode, shot.shotId)] += 1;
  const tasks = { pending: 0, inFlight: 0, failed: 0, needsConfirmation: 0, completed: 0 };
  for (const task of episode.tasks) {
    if (task.state === "pending") tasks.pending += 1;
    else if (["reserved", "queued", "running", "fetching"].includes(task.state)) tasks.inFlight += 1;
    else if (task.state === "failed") tasks.failed += 1;
    else if (task.state === "needs_confirmation") tasks.needsConfirmation += 1;
    else if (task.state === "completed") tasks.completed += 1;
  }
  return { episodeId: episode.episodeId, title: episode.title, shots: episode.shots.length, paused: episode.paused, stages, tasks, updatedAt: episode.updatedAt };
}
