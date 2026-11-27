/**
 * Production line (生产线) — data model. One JSON ledger per episode is the source of truth; the
 * worker inside the dev server owns it, the browser only reads it and sends commands.
 *
 *   Episode → Shot → Version (keyframe | video candidates) ← Task (one ComfyUI prompt each)
 *
 * Stage gate: a shot's video is only generated from its approved keyframe. Cheap keyframes absorb the
 * re-rolls; expensive H3 videos run only on approved material.
 */

export const PRODUCTION_SCHEMA = "production-episode-v1" as const;
export const EPISODE_ID_PATTERN = /^ep-\d{8}-\d{6}-[0-9a-f]{4}$/;
export const MEDIA_NAME_PATTERN = /^[A-Za-z0-9㐀-鿿][A-Za-z0-9㐀-鿿 ._()（）-]{0,119}\.(png|jpe?g|webp|wav|mp3|flac|m4a)$/i;

export type Aspect = "9:16" | "16:9";
export type StageKind = "keyframe" | "video";
export type VersionStatus = "candidate" | "approved" | "rejected";
/**
 * pending → reserved (prompt_id on disk, /prompt not yet answered) → queued/running → fetching → completed.
 * needs_confirmation: reserved but ComfyUI has no trace of it — never resubmitted without the user.
 */
export type TaskState = "pending" | "reserved" | "queued" | "running" | "fetching" | "completed" | "failed" | "needs_confirmation" | "cancelled";
export const OPEN_TASK_STATES: readonly TaskState[] = ["pending", "reserved", "queued", "running", "fetching", "needs_confirmation"];
export const IN_FLIGHT_STATES: readonly TaskState[] = ["reserved", "queued", "running", "fetching"];

export interface RoleSpec {
  key: string;
  name: string;
  /** Face crop used by PuLID for keyframes. Media name inside the episode inputs. */
  face: string | null;
  /** Appearance images; the first is the role's primary appearance handed to H3 (as on the canvas). */
  appearance: string[];
  /** Primary voice (audio media name) for dialogue; null = no voice reference. */
  voice: string | null;
  /** Stable identity description used by the H3 compiler's subject definition. */
  description: string;
}

/** Same shape as the canvas queue's dialogue: roleId = role key, or speaker + voice ("none" | "audio:<media name>"). */
export interface DialogueLine { roleId: string; text: string; speaker?: string; voice?: string }

export interface ShotSpec {
  shotId: string;
  title: string;
  /** Composition image (depth map source); null = keyframe from keyframePrompt only. */
  storyboard: string | null;
  /** Role whose face PuLID locks on the keyframe; null = no identity lock (empty shot / extras). */
  faceRole: string | null;
  faceWeight: number;
  /** English. With a storyboard: appearance only (camera and pose come from its depth). Without: also the framing, camera and positions. */
  keyframePrompt: string;
  /** Full H3 prompt (the canvas queue's prompt text). The approved keyframe is the first frame. */
  videoPrompt: string;
  /** Roles in the shot: primary appearance after the first frame, voices for dialogue. */
  roles: string[];
  dialogue: DialogueLine[];
  /** Speaking role when the prompt carries <d> dialogue without structured lines. */
  voiceRole: string | null;
  /** Roles that speak but are not on screen (no appearance image). */
  offscreen: string[];
  seconds: number;
  seed: number | null;
}

export interface KeyframeSettings { look: string; depthStrength: number; candidates: number; autoApproveAbove: number | null }
export interface VideoSettings { workflow: "ultimate"; tuning: "default" | "understanding"; soundMode: "av" | "ambient" | "silent"; megapixels: number; candidates: number }

export interface ScoreSet {
  /** Cosine similarity of the main face to the role face (insightface, CPU). null = no face found. */
  face?: number | null;
  faces?: number;
  /** Technical video checks (PyAV). */
  duration?: number;
  hasAudio?: boolean;
  blackFrames?: number;
  frozenRatio?: number;
  problems?: string[];
  checkedAt?: string;
  error?: string;
}

export interface Version {
  versionId: string;
  stage: StageKind;
  shotId: string;
  taskId: string;
  /** Path relative to the episode folder. */
  file: string;
  extra?: Record<string, string>;
  seed: number;
  status: VersionStatus;
  score: ScoreSet | null;
  createdAt: string;
  decidedAt: string | null;
  note: string;
}

export interface TaskAttempt { promptId: string; reservedAt: string; acceptedAt: string | null; outcome: "reserved" | "accepted" | "completed" | "failed" | "lost" | "not_sent" | "cancelled"; error: string | null; misses?: number; fetchFailures?: number }

export interface Task {
  taskId: string;
  stage: StageKind;
  shotId: string;
  seed: number;
  state: TaskState;
  /** Video tasks: the approved keyframe version they start from. */
  sourceVersionId: string | null;
  attempts: TaskAttempt[];
  retries: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  versionId: string | null;
}

export interface EpisodeLogEntry { at: string; action: string; shotId?: string; taskId?: string; detail?: string }

export interface Episode {
  schema: typeof PRODUCTION_SCHEMA;
  episodeId: string;
  title: string;
  aspect: Aspect;
  roles: RoleSpec[];
  shots: ShotSpec[];
  keyframe: KeyframeSettings;
  video: VideoSettings;
  tasks: Task[];
  versions: Version[];
  /** Worker stops taking new tasks from this episode; in-flight ComfyUI prompts finish normally. */
  paused: boolean;
  /** Canvas instance that owns this episode ("" = the default 5173 canvas, else e.g. "page1", "yemian2"). */
  canvas?: string;
  createdAt: string;
  updatedAt: string;
  log: EpisodeLogEntry[];
}

export const STAGE_FAMILY: Record<StageKind, string> = { keyframe: "flux-dev", video: "h3" };
