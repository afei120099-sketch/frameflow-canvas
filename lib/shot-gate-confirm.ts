/**
 * 画面五项被拦时，用户在画布卡片里亲手点「我确认没问题」并写理由，这一镜才能入队（用户 2026-11-11 拍板）。
 * - 只存在画布这边：IndexedDB meta（和修改历史同一个库，跟项目备份 / 每日备份走），**不写进队列 JSON**。
 *   队列 JSON、收件箱文件里自带的任何「确认 / 跳过检查」字段一律不读——这里只认下面的 store。
 * - 只对确认时那一段正文有效：记录里存着当时的完整正文，正文一字不同就失效（一键预设、整集都换、撤销恢复都算改）；
 *   卡片看到失效的记录会删掉，撤销回原文也不会复活，要重新确认。
 * - 按镜头标题存；跨队列同标题时靠正文一致性区分。
 * - 记进 Run 的 parameters 里的 gateOverride（提交时按节点的镜头标题 + 正文查），审片统计可以单独算这一类。
 */
import type { CategoryId } from "./zhengben-categories.ts";

export interface GateConfirmation {
  /** 确认时的完整正文；当前正文和它不一样就失效 */
  prompt: string;
  reason: string;
  /** 确认时被拦的五项（2026-11-12 起也可能有 "opening_gap" 开场空白） */
  items: (CategoryId | string)[];
  queueTitle: string;
  shotTitle: string;
  confirmedAt: string;
}
export type GateConfirmLookup = (shot: { title: string; prompt: string }) => GateConfirmation | null;

type Meta = { get: (key: string) => Promise<GateConfirmation | null | undefined>; put: (key: string, value: GateConfirmation | null) => Promise<unknown> };
export const gateConfirmKey = (shotTitle: string) => `shot-gate-confirm:v1:${shotTitle}`;

const valid = (value: unknown): value is GateConfirmation => !!value && typeof value === "object" && typeof (value as GateConfirmation).prompt === "string" && typeof (value as GateConfirmation).reason === "string" && (value as GateConfirmation).reason.trim().length > 0;

/** 这条记录对这一镜现在的正文还算不算数。 */
export const confirmationHolds = (record: GateConfirmation | null | undefined, shot: { title: string; prompt: string }) => valid(record) && record.shotTitle === shot.title && record.prompt === shot.prompt;

export class GateConfirmStore {
  private meta: Meta;
  constructor(meta: Meta) { this.meta = meta; }
  async read(shot: { title: string; prompt: string }) {
    const record = await this.meta.get(gateConfirmKey(shot.title)).catch(() => null);
    return { record: valid(record) ? record : null, holds: confirmationHolds(record, shot) };
  }
  /** 只认当前正文的确认。dropStaleOf = 当前队列标题：同一队列里正文改过的记录顺手删掉（撤销回原文也不会复活）；别的队列的同名镜头不动。 */
  async current(shot: { title: string; prompt: string }, dropStaleOf?: string) {
    const { record, holds } = await this.read(shot);
    if (record && !holds && dropStaleOf !== undefined && record.queueTitle === dropStaleOf) await this.meta.put(gateConfirmKey(shot.title), null).catch(() => {});
    return holds ? record : null;
  }
  /** 一份队列里所有还算数的确认，给入队判断用（同步查）。 */
  async lookupFor(shots: readonly { title: string; prompt: string }[]): Promise<GateConfirmLookup> {
    const found = new Map<string, GateConfirmation>();
    for (const shot of shots) { const record = await this.current(shot); if (record) found.set(shot.title, record); }
    return (shot) => { const record = found.get(shot.title); return record && confirmationHolds(record, shot) ? record : null; };
  }
  async confirm(input: Omit<GateConfirmation, "confirmedAt">) {
    if (!input.reason.trim()) throw new Error("要写一句理由才能确认");
    const record: GateConfirmation = { ...input, reason: input.reason.trim(), confirmedAt: new Date().toISOString() };
    await this.meta.put(gateConfirmKey(input.shotTitle), record);
    return record;
  }
  revoke(shotTitle: string) { return this.meta.put(gateConfirmKey(shotTitle), null); }
}
