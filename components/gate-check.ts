"use client";

/**
 * 入队前的画面五项判定（全部入队 / 本章入队 / 收件箱共用）：先跑正本 h3q check，五项以 h3q 的 [五项·…] ERROR 为准；
 * h3q 没跑成、输出看不懂、或正本早于 v2026-11-11.4（还不查五项）时，用画布完整度判定兜底，拦截原因里写明是兜底。
 * 再叠上用户在卡片里亲手确认过的镜头（画布 store，不读队列 JSON）。说明见 lib/shot-gate.ts。
 */
import { parseH3qOutput } from "@/lib/h3q-report";
import { runH3qCheck } from "@/lib/zhengben-client";
import { H3Q_FIVE_SINCE, h3qChecksFive, queueGate, type GateBasis } from "@/lib/shot-gate";
import type { ShotQueue } from "@/lib/shot-queue";
import { gateConfirmStore } from "@/components/gate-confirm-store";
import { attachEpisodeH3qItems, shotQueueJson } from "@/lib/episode-settings";

/** 五项不依赖对照表：不带 tableFile（h3q 用 --skip-table）。 */
export async function gateBasisFor(queue: ShotQueue): Promise<GateBasis> {
  // 发写回版 JSON（本集设定是占位版，h3q 自己展开；不带画布内部字段 promptTemplate）。
  const result = await runH3qCheck(JSON.parse(shotQueueJson(queue)));
  if (!result.ok) return { source: "canvas", why: `h3q 没跑成：${result.error}` };
  if (!h3qChecksFive(result.version)) return { source: "canvas", why: `正本版本 ${result.version} 早于 ${H3Q_FIVE_SINCE}，h3q 还不查五项` };
  const report = parseH3qOutput(result.output, queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title)));
  // 设定值里的问题 h3q 只报在「本集设定.…」上：抄到用到它的镜头，五项才拦得住。
  return report ? { source: "h3q", report: attachEpisodeH3qItems(report, queue) } : { source: "canvas", why: "h3q 的输出看不懂（没有「结果: ERROR …」那一行）" };
}

export async function checkQueueGate(queue: ShotQueue, chapter?: number) {
  const [basis, confirmed] = await Promise.all([gateBasisFor(queue), gateConfirmStore.lookupFor(queue.chapters.flatMap((part) => part.shots))]);
  return queueGate(queue, chapter, confirmed, basis);
}
