"use client";
/**
 * 镜头卡片里的去配乐按钮（视频列和放大层共用）和「整集去配乐」。
 * 提交一律走 lib/music-removal.ts 的 enqueueMusicRemoval —— 和画布节点「去配乐」「再去一次」、右键批量同一个函数，
 * 结果照旧挂在同一个 H3 节点上（新版本），原声版保留。
 */
import { useState } from "react";
import { askConfirm } from "@/components/in-page-dialog";
import { enqueueMusicRemoval, enqueueReasonText, type DemixStateRow } from "@/lib/music-removal";
import { estimateMusicRemovalSeconds } from "@/lib/comfyui/music-removal-workflow";
import { cardDemixState, planEpisodeDemix, type EpisodeDemixItem } from "@/lib/shot-card-demix";
import type { AssetRecord } from "@/lib/production-records";

type DemixAsset = Pick<AssetRecord, "assetId" | "derivationType" | "sourceVideoAssetId" | "musicRemovalPasses">;

/** `onShow`：视频列里 = 选用那条（同点 A/B/C）；放大层里 = 只是切过去看。 */
export function DemixCardControl({ asset, nodeId, versions, row, onShow, showHint, compact }: { asset: DemixAsset; nodeId: string; versions: DemixAsset[]; row: DemixStateRow | null; onShow: (assetId: string) => void; showHint: string; compact?: boolean }) {
  const [note, setNote] = useState("");
  const state = cardDemixState(asset, versions, row);
  const { action } = state;
  const run = async (retry: boolean) => {
    setNote("");
    const result = await enqueueMusicRemoval({ sourceAssetId: asset.assetId, nodeId, retry });
    setNote(result.queued ? `已排进去配乐队列（${result.pass > 1 ? "再去一次，" : ""}排在已有出片后面）` : enqueueReasonText[result.reason]);
  };
  return <div className={`scd ${compact ? "compact" : ""}`}>
    <span className="scd-sound" title="现在看的这一条">{state.sound}</span>
    {action.kind === "run" ? <button type="button" className={`scd-btn ${action.retry ? "failed" : ""}`} title={action.title} onClick={() => void run(action.retry)}>{action.label}</button>
      : action.kind === "show" ? <button type="button" className="scd-btn" title={`${action.title}。${showHint}`} onClick={() => onShow(action.assetId)}>{action.label}</button>
      : <span className={`scd-chip ${action.kind}`} title={action.title} aria-live="polite">{action.label}</span>}
    {state.original && <button type="button" className="scd-btn" title={`切回原声版。${showHint}`} onClick={() => onShow(state.original!)}>切回原声</button>}
    {note && <em className="scd-note" role="status">{note}</em>}
  </div>;
}

/** 整集去配乐：页面内确认（处理几条、跳过几条、大概多久），一条一个任务依次排队。返回给卡片顶上那一行的说明。 */
export async function runEpisodeDemix<T extends EpisodeDemixItem>(items: T[], noVideo: number, row: DemixStateRow | null): Promise<string> {
  const plan = planEpisodeDemix(items, row);
  const reasons = [...new Set(plan.skipped.map((entry) => entry.reason))].map((reason) => `${reason} ${plan.skipped.filter((entry) => entry.reason === reason).length} 条`).join("、");
  if (!plan.todo.length) return `整集去配乐：没有要处理的（${items.length} 镜有视频${reasons ? `，${reasons}` : ""}${noVideo ? `；${noVideo} 镜还没视频` : ""}）`;
  const estimate = estimateMusicRemovalSeconds(plan.todo.map((item) => item.duration));
  const ok = await askConfirm({
    title: "整集去配乐",
    message: `只处理每镜视频列当前显示的那条。\n\n要处理 ${plan.todo.length} 条：${plan.todo.map((item) => item.code).join("、")}${plan.skipped.length ? `\n跳过 ${plan.skipped.length} 条（${reasons}）` : ""}${noVideo ? `\n另有 ${noVideo} 镜还没出视频` : ""}。\n\n每条单独一个任务，一个做完再交下一个，排在已有的出片任务后面。\n预计：显卡约 ${Math.max(1, Math.round(estimate.gpu / 60))} 分钟；显存不够改用 CPU 约 ${Math.max(1, Math.round(estimate.cpu / 60))} 分钟。\n\n原视频不动，去配乐版作为新版本挂在原来的节点上，卡片里可以切回原声。`,
    confirmLabel: `开始去配乐（${plan.todo.length} 条）`,
  });
  if (!ok) return "已取消整集去配乐";
  let queued = 0;
  const refused: string[] = [];
  for (const item of plan.todo) {
    const result = await enqueueMusicRemoval({ sourceAssetId: item.asset.assetId, nodeId: item.nodeId });
    if (result.queued) queued++; else refused.push(`${item.code}：${enqueueReasonText[result.reason]}`);
  }
  return `整集去配乐：已排队 ${queued} 条${plan.skipped.length ? `，跳过 ${plan.skipped.length} 条` : ""}${refused.length ? `；没排上 ${refused.join("；")}` : ""}。进度看每镜视频下面。`;
}

export const DEMIX_CARD_STYLE = `
.scd{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;font-size:12px;color:var(--ff-text-3)}
.scd-sound{color:var(--ff-text-2)}
.scd-btn,.scd-chip{display:inline-flex;align-items:center;padding:1px 8px;border-radius:var(--ff-r-sm);border:1px solid var(--ff-border);background:var(--ff-control);color:var(--ff-text-2);font-size:12px;line-height:20px;white-space:nowrap}
.scd-btn:hover{background:var(--ff-hover);color:var(--ff-text)}
.scd-btn.failed{border-style:dashed;color:var(--ff-text)}
.scd-chip{background:transparent;border-style:dashed}
.scd-chip.processed{color:var(--ff-text-3)}
.scd-note{flex-basis:100%;font-style:normal;color:var(--ff-text-3)}
`;
