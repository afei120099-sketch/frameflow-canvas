import { IN_FLIGHT_STATES, STAGE_FAMILY, type Episode, type StageKind, type Task } from "./types.ts";

/**
 * Which task goes to ComfyUI next. One production task in flight at a time (one GPU). Rules, in order:
 *  1. nothing new while any production task is in flight, or a task waits for the user's confirmation
 *     in the same episode (a doubt about one prompt blocks that episode, not the others);
 *  2. nothing new while ComfyUI holds anybody else's work (the canvas and the user come first);
 *  3. stay on the model family that is loaded (keyframes → Flux, videos → H3) while it has work,
 *     so 20–46 GB of weights are not swapped for every task;
 *  4. otherwise keyframes before videos (cheap gate first), then episode creation order, then shot order.
 */
export interface SchedulerInput {
  episodes: readonly Episode[];
  comfyBusy: boolean;
  lastStage: StageKind | null;
}

export type SchedulerDecision =
  | { kind: "submit"; episodeId: string; task: Task }
  | { kind: "wait"; reason: "in_flight" | "comfy_busy" | "idle" | "paused" };

export function nextTask({ episodes, comfyBusy, lastStage }: SchedulerInput): SchedulerDecision {
  if (episodes.some((episode) => episode.tasks.some((task) => IN_FLIGHT_STATES.includes(task.state)))) return { kind: "wait", reason: "in_flight" };
  const runnable = episodes
    .filter((episode) => !episode.paused && !episode.tasks.some((task) => task.state === "needs_confirmation"))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const candidates: { episode: Episode; task: Task; order: number }[] = [];
  for (const episode of runnable) {
    const shotOrder = new Map(episode.shots.map((shot, index) => [shot.shotId, index]));
    for (const task of episode.tasks) if (task.state === "pending") candidates.push({ episode, task, order: shotOrder.get(task.shotId) ?? 0 });
  }
  if (!candidates.length) return { kind: "wait", reason: episodes.some((episode) => episode.paused && episode.tasks.some((task) => task.state === "pending")) ? "paused" : "idle" };
  if (comfyBusy) return { kind: "wait", reason: "comfy_busy" };
  const family = lastStage ? STAGE_FAMILY[lastStage] : null;
  const rank = (stage: StageKind) => (family && STAGE_FAMILY[stage] === family ? 0 : 1) * 10 + (stage === "keyframe" ? 0 : 1);
  candidates.sort((a, b) => rank(a.task.stage) - rank(b.task.stage) || a.episode.createdAt.localeCompare(b.episode.createdAt) || a.order - b.order || a.task.createdAt.localeCompare(b.task.createdAt));
  const pick = candidates[0];
  return { kind: "submit", episodeId: pick.episode.episodeId, task: pick.task };
}
