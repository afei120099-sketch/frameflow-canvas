import type { AssetRecord } from "./production-records.ts";
import type { FinalCutItem, FinalCutList } from "./final-cut-list.ts";

/** Human decisions bind the exact source and trim, not a mutable Shot or title. */
export interface ClipReview {
  decision: "approved" | "rejected";
  fingerprint: string;
  reviewedAt: number;
}
export type ReviewState = "pending" | "approved" | "rejected" | "stale";
export const REVIEW_LABELS: Record<ReviewState, string> = { pending: "待审核", approved: "已通过", rejected: "需重做", stale: "素材或裁切已变化，请重新审核" };

function fingerprint(item: FinalCutItem, asset: AssetRecord | null) {
  if (!asset || asset.kind !== "video") return null;
  return JSON.stringify([item.assetId, asset.storageReference, asset.sourceRunId, asset.fileSize ?? null,
    asset.width ?? null, asset.height ?? null, asset.duration ?? null, item.sourceDuration, item.inPoint, item.outPoint]);
}

export function clipReviewState(item: FinalCutItem, asset: AssetRecord | null): ReviewState {
  const review = item.review;
  if (!review) return "pending";
  if (!Number.isFinite(review.reviewedAt) || review.fingerprint !== fingerprint(item, asset)) return "stale";
  return review.decision === "approved" ? "approved" : review.decision === "rejected" ? "rejected" : "pending";
}

export function reviewClip(list: FinalCutList, itemId: string, asset: AssetRecord | null, decision: ClipReview["decision"], now = Date.now()): FinalCutList {
  const item = list.items.find((entry) => entry.itemId === itemId);
  if (!item) throw new Error("该片段已不在成片序列中");
  if (!asset || asset.assetId !== item.assetId || asset.kind !== "video") throw new Error("素材已失效，不能审核");
  const duration = asset.duration ?? item.sourceDuration;
  if (!duration || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(item.inPoint) ||
    item.inPoint < 0 || item.outPoint === null || !Number.isFinite(item.outPoint) ||
    item.outPoint <= item.inPoint || item.outPoint > duration + 0.0005) throw new Error("先确认视频时长和有效裁切范围，再审核");
  const review: ClipReview = { decision, fingerprint: fingerprint(item, asset)!, reviewedAt: now };
  return { ...list, updatedAt: now, items: list.items.map((entry) => entry.itemId === itemId ? { ...entry, review, updatedAt: now } : entry) };
}

/** Opt-in: old lists remain free editing. No approval is invented for old/adopted clips. */
export function setReviewRequired(list: FinalCutList, required: boolean, now = Date.now()): FinalCutList {
  return { ...list, requireReview: required, updatedAt: now };
}
