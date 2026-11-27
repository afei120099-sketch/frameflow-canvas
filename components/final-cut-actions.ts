"use client";
// 历史 final-cut-button.tsx 仍引用本模块；不满足零引用删除条件，保留。
// Phase 18 / 18.1: the single "加入成片" add / cancel logic used by the video node, Asset Library,
// Shot Board and lineage view (through components/final-cut-button.tsx).
import { addAssetToFinalCutList, removeAssetFromFinalCutList, type AddToFinalCutOptions } from "@/lib/final-cut-store";
import { UNKNOWN_DURATION } from "@/lib/final-cut-list";
import { getLocalVideoBlob, readVideoDurationSeconds } from "@/lib/local-video-store";
import type { AssetRecord } from "@/lib/production-records";

export const OPEN_FINAL_CUT_EVENT = "frameflow-open-final-cut";
/** Asks the canvas to open the Final Cut List drawer. */
export const openFinalCut = () => window.dispatchEvent(new Event(OPEN_FINAL_CUT_EVENT));

/** Only used when the Asset record has no duration; reads the stored video's own metadata. */
export const probeVideoDuration = async (asset: AssetRecord) => readVideoDurationSeconds(await getLocalVideoBlob(asset.storageReference));

/** Adds any video Asset to the Final Cut List; resolves with a message, rejects with a readable error. */
export async function addToFinalCut(assetId: string, options: Omit<AddToFinalCutOptions, "probeDuration"> = {}) {
  const { list, item, durationKnown } = await addAssetToFinalCutList(assetId, { ...options, probeDuration: probeVideoDuration });
  return durationKnown ? `已加入成片序列 · 第 ${item.order} 段（共 ${list.items.length} 段）` : `已加入成片序列 · 第 ${item.order} 段，但${UNKNOWN_DURATION}，请在成片序列中确认`;
}

/** Cancels one addition: the only one, or the most recent when the Asset is used several times. */
export async function cancelFinalCut(assetId: string, which: "only" | "latest") {
  const { remaining } = await removeAssetFromFinalCutList(assetId, which);
  return remaining ? `已取消最近一次加入（该素材仍在成片序列中 ${remaining} 次）` : "已从成片序列取消（素材仍在素材库）";
}

