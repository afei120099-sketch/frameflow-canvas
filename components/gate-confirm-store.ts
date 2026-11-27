"use client";

/** 画布这边唯一的「我确认没问题」记录（IndexedDB meta，跟备份走）。说明见 lib/shot-gate-confirm.ts。 */
import { getMeta, putMeta } from "@/lib/production-records";
import { GateConfirmStore, type GateConfirmation } from "@/lib/shot-gate-confirm";

export const gateConfirmStore = new GateConfirmStore({ get: (key) => getMeta<GateConfirmation | null>(key), put: (key, value) => putMeta(key, value) });

/** 提交时写进 Run.parameters.gateOverride：这一镜（按节点的镜头标题 + 正文）是不是用户亲手确认放行的。 */
export async function gateOverrideFor(shotTitle: string | undefined, prompt: string | undefined) {
  if (!shotTitle || prompt === undefined) return undefined;
  const record = await gateConfirmStore.current({ title: shotTitle, prompt }).catch(() => null);
  return record ? { reason: record.reason, items: record.items, confirmedAt: record.confirmedAt, queueTitle: record.queueTitle } : undefined;
}
