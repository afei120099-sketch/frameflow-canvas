"use client";

/**
 * 镜头卡片里「我确认没问题」的状态：读画布 store 里这份队列每一镜还算数的确认（正文改过的顺手删掉），确认 / 取消后重读。
 * 说明见 lib/shot-gate-confirm.ts。只在卡片里用；入队判断各自从 store 现读，不信这里的缓存。
 */
import { useCallback, useEffect, useState } from "react";
import { gateConfirmStore } from "@/components/gate-confirm-store";
import { confirmationHolds, type GateConfirmation, type GateConfirmLookup } from "@/lib/shot-gate-confirm";
import type { CategoryId } from "@/lib/zhengben-categories";
import type { ShotQueue, ShotQueueShot } from "@/lib/shot-queue";

export interface GateRowCtx { confirmation: GateConfirmation | null; confirm: (items: string[], reason: string) => Promise<string | null>; revoke: () => Promise<void> }

export function useGateConfirmations(queue: ShotQueue) {
  const [records, setRecords] = useState<Map<string, GateConfirmation>>(() => new Map());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const shots = queue.chapters.flatMap((chapter) => chapter.shots);
    void Promise.all(shots.map((shot) => gateConfirmStore.current(shot, queue.title).then((record) => [shot.title, record] as const)))
      .then((rows) => { if (alive) setRecords(new Map(rows.filter((row): row is readonly [string, GateConfirmation] => row[1] !== null))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [queue, tick]);
  const lookup = useCallback<GateConfirmLookup>((shot) => { const record = records.get(shot.title); return record && confirmationHolds(record, shot) ? record : null; }, [records]);
  const rowFor = (shot: ShotQueueShot): GateRowCtx => ({
    confirmation: lookup(shot),
    confirm: async (items, reason) => {
      if (!reason.trim()) return "要写一句理由才能确认";
      try { await gateConfirmStore.confirm({ prompt: shot.prompt, reason, items, queueTitle: queue.title, shotTitle: shot.title }); setTick((n) => n + 1); return null; }
      catch (cause) { return cause instanceof Error ? cause.message : "确认没存上"; }
    },
    revoke: async () => { await gateConfirmStore.revoke(shot.title).catch(() => {}); setTick((n) => n + 1); },
  });
  return { lookup, rowFor };
}
