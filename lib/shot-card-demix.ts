/**
 * 镜头卡片里的去配乐：按钮该显示什么、「整集去配乐」挑哪几条。纯函数；真正提交用的是
 * lib/music-removal.ts 的 enqueueMusicRemoval —— 和画布 H3 节点「去配乐」「再去一次」、右键批量是同一个函数。
 */
import { demixViewFor, isActiveDemix, MAX_MUSIC_REMOVAL_PASSES, musicRemovalPassesOf, type DemixJob, type DemixStateRow } from "./music-removal.ts";
import type { AssetRecord } from "./production-records.ts";

type DemixAsset = Pick<AssetRecord, "assetId" | "derivationType" | "sourceVideoAssetId" | "musicRemovalPasses">;

export type CardDemixAction =
  | { kind: "run"; label: string; title: string; retry: boolean }
  | { kind: "busy"; label: string; title: string }
  | { kind: "show"; label: string; title: string; assetId: string }
  | { kind: "processed"; label: string; title: string };

export interface CardDemixState {
  /** 原声版 / 去配乐版 / 去配乐 ×2 版 */
  sound: string;
  action: CardDemixAction;
  /** 去配乐版：原声版的 assetId（「切回原声」） */
  original: string | null;
}

const busyLabel = (job: DemixJob) => job.state === "waiting" ? "去配乐排队中" : job.stage || "正在去配乐";

/** 视频列 / 放大层里那条视频下面的去配乐按钮。规则和画布节点（DemixNodeControl）一致。 */
export function cardDemixState(asset: DemixAsset, versions: DemixAsset[], row: DemixStateRow | null): CardDemixState {
  const view = demixViewFor(asset, row);
  if (view.kind === "output") {
    const sound = view.passes > 1 ? `去配乐 ×${view.passes} 版` : "去配乐版";
    const job = view.job;
    const action: CardDemixAction = !view.canRunAgain ? { kind: "processed", label: "已处理过", title: `已经去过 ${MAX_MUSIC_REMOVAL_PASSES} 遍配乐，不再处理` }
      : job?.state === "done" && job.outputAssetId ? { kind: "show", label: "看 ×2 版", title: "已再去一次，点一下看去配乐 ×2 版", assetId: job.outputAssetId }
      : isActiveDemix(job) ? { kind: "busy", label: `${busyLabel(job!)}…`, title: job!.state === "waiting" ? "在画布里排队，前一个去配乐完成后才提交" : "已提交到 ComfyUI" }
      : job?.state === "failed" ? { kind: "run", label: "再去一次失败 · 重试", title: `再去一次失败：${job.error ?? "未知原因"}。点一下重试`, retry: true }
      : { kind: "run", label: "再去一次", title: "还能听到音乐时用：把这个去配乐版再交一次 CDX23（结果是「去配乐 ×2」新版本，这一版和原声版都保留）", retry: false };
    return { sound, action, original: view.originalAssetId };
  }
  const job = view.kind === "source" ? view.job : undefined;
  const made = versions.find((item) => item.derivationType === "music_removal" && item.sourceVideoAssetId === asset.assetId && musicRemovalPassesOf(item) === 1);
  const output = job?.state === "done" && job.outputAssetId ? job.outputAssetId : made?.assetId;
  const action: CardDemixAction = output ? { kind: "show", label: "看去配乐版", title: "已去配乐，点一下看去配乐版（原声版保留）", assetId: output }
    : job?.state === "skipped" ? { kind: "processed", label: "已处理过", title: "这个视频本身已经去过配乐，节点跳过了，没有出新文件" }
    : isActiveDemix(job) ? { kind: "busy", label: `${busyLabel(job!)}…`, title: job!.state === "waiting" ? "在画布里排队，前一个去配乐完成后才提交" : "已提交到 ComfyUI" }
    : job?.state === "failed" ? { kind: "run", label: "去配乐失败 · 重试", title: `去配乐失败：${job.error ?? "未知原因"}。点一下重试`, retry: true }
    : { kind: "run", label: "去配乐", title: "去掉背景音乐，只留台词和音效（CDX23）。结果是同一节点的新版本，原声版保留", retry: false };
  return { sound: "原声版", action, original: null };
}

export interface EpisodeDemixItem { title: string; code: string; asset: DemixAsset; nodeId: string; duration: number; versions: DemixAsset[] }
export interface EpisodeDemixPlan<T extends EpisodeDemixItem = EpisodeDemixItem> { todo: T[]; skipped: { item: T; reason: string }[] }

/**
 * 整集去配乐：每镜只看视频列当前显示的那条；只挑还没去过配乐的原声版（去配乐版、已去过、正在处理、节点认出已处理过的都跳过）。
 */
export function planEpisodeDemix<T extends EpisodeDemixItem>(items: T[], row: DemixStateRow | null): EpisodeDemixPlan<T> {
  const plan: EpisodeDemixPlan<T> = { todo: [], skipped: [] };
  const seen = new Set<string>();
  for (const item of items) {
    const job = row?.jobs[item.asset.assetId];
    const made = item.versions.some((version) => version.derivationType === "music_removal" && version.sourceVideoAssetId === item.asset.assetId);
    const reason = item.asset.derivationType === "music_removal" ? "显示的已经是去配乐版"
      : job?.state === "done" || made ? "已经去过配乐"
      : job?.state === "skipped" ? "已处理过"
      : isActiveDemix(job) ? "正在去配乐"
      : seen.has(item.asset.assetId) ? "和前面的是同一个视频" : "";
    seen.add(item.asset.assetId);
    if (reason) plan.skipped.push({ item, reason }); else plan.todo.push(item);
  }
  return plan;
}
