/**
 * 画面五项·必写（用户 2026-11-11：「有的AI做不好提示词，应该在卡片审核里面就卡死了」）：
 * 风格胶片、光线、景别焦段、构图、运镜机位——任何一项在某镜漏写或写错，这镜不准入队；整集 / 本章入队时有一镜不过就整批不提交。没有一键强行入队，只有下面那种逐镜亲手确认。
 * 判定以正本 h3q 为准：正本 v2026-11-11.4 起 `h3q.py check` 对五项缺写 / 写错报 ERROR，消息以 [五项·风格胶片] [五项·光线] [五项·景别焦段] [五项·构图] [五项·运镜机位] 开头（h3工具 7b1717e）。
 *   本集设定的 {{本集.…}} 占位 h3q 会先展开再查（0a89c12），不会把占位当成漏写。
 * h3q 没跑成（开发服务器助手没起、python 报错、正本早于 v2026-11-11.4……）时用画布自己的完整度判定兜底（lib/prompt-completeness.ts，只看「有没有写到」），
 *   拦截原因里写明「画布兜底判定」。兜底时 {{本集.风格}} / {{本集.光线.场景}} 占位算写了（展开后的对错等 h3q 能跑时再查）。
 * 例外：用户在画布卡片里亲手点「我确认没问题」并写理由（lib/shot-gate-confirm.ts，只存在画布 IndexedDB，正文一改就失效）。
 *   队列 JSON / 收件箱文件里的任何确认字段都不读：这里只接受调用方从画布 store 查出来的 confirmed。
 * 其余完整度类别只提示、不拦。2026-11-12 起 h3q 判定时**每一条单镜 ERROR 都拦**，分组 / 名字 / 改法见 lib/hard-rules.ts（整集 ERROR 只显示）。
 * 2026-11-12 起同一套拦法还管「开场空白」（有台词的镜头第一句前空超过 1 秒，h3q [开场空白] ERROR；兜底见 lib/opening-gap.ts）。
 */
import { shotCompleteness, type CategoryResult } from "./prompt-completeness.ts";
import { CATEGORY_BY_ID, type CategoryId } from "./zhengben-categories.ts";
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";
import type { H3qItem, H3qReport } from "./h3q-report.ts";
import { confirmationHolds, type GateConfirmLookup } from "./shot-gate-confirm.ts";
import { OPENING_GAP_ID, OPENING_GAP_LABEL, canvasOpeningGap, canvasOpeningGapNote } from "./opening-gap.ts";
import { OTHER_H3Q_ERROR, hardRuleById, hardRuleOf } from "./hard-rules.ts";
import { OFFICIAL_VOICE_ID, OFFICIAL_VOICE_LABEL, officialVoiceProblem } from "./official-format.ts";

export const GATE_CATEGORIES: readonly CategoryId[] = ["style", "light", "shotsize", "compose", "camera"];
export const GATE_LABEL = "画面五项";
export const isGateCategory = (id: CategoryId) => GATE_CATEGORIES.includes(id);

/** 被拦的一项：画面五项的类别，或开场空白。 */
export type GateItemId = CategoryId | string;
export interface GateItem { id: GateItemId; label: string; note: string; /** h3q = 正本 h3q 报的 ERROR；canvas = 画布完整度判定（h3q 没跑成时的兜底） */ source: "h3q" | "canvas" }
export interface GateFailure { chapter: number; index: number; title: string; code: string; items: GateItem[] }
/** 这次五项按什么判：正本 h3q 的报告，或者画布兜底（why = h3q 为什么没用上）。 */
export type GateBasis = { source: "h3q"; report: H3qReport } | { source: "canvas"; why: string };

/** h3q 五项 ERROR 的前缀 → 类别（正本 v2026-11-11.4 起）。 */
const H3Q_TAG = /\[五项·(风格胶片|光线|景别焦段|构图|运镜机位)\]/;
const H3Q_TAG_ID: Record<string, CategoryId> = { 风格胶片: "style", 光线: "light", 景别焦段: "shotsize", 构图: "compose", 运镜机位: "camera" };
export const h3qGateCategory = (message: string): CategoryId | null => { const m = H3Q_TAG.exec(message); return m ? H3Q_TAG_ID[m[1]] : null; };

/** h3q 从哪一版开始查五项。早于它（或版本读不到）时 h3q 什么五项 ERROR 都不会报，不能当作通过，要用画布兜底。 */
export const H3Q_FIVE_SINCE = "v2026-11-11.4";
export function h3qChecksFive(version: string | undefined) {
  const m = /v?(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?/.exec(version ?? "");
  if (!m) return false;
  const have = m.slice(1).map((part) => Number(part ?? 0)), need = [2026, 11, 11, 4];
  for (let i = 0; i < 4; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

/** 一镜的 h3q 结果里的五项 ERROR，按类别合并（同一类可能报好几条）。 */
export function h3qGateItems(items: readonly H3qItem[]): GateItem[] {
  const found = new Map<CategoryId, string[]>();
  for (const item of items) { if (item.level !== "ERROR") continue; const id = h3qGateCategory(item.message); if (id) (found.get(id) ?? found.set(id, []).get(id)!).push(item.message.replace(H3Q_TAG, "").trim()); }
  return GATE_CATEGORIES.filter((id) => found.has(id)).map((id) => ({ id, label: CATEGORY_BY_ID[id].label, note: found.get(id)!.join("；"), source: "h3q" as const }));
}

/** 兜底时：正文里用了本集设定占位的类别算写了（{{本集.风格}} → 风格胶片，{{本集.光线.场景}} → 光线）。 */
function placeheld(prompt: string) {
  const held = new Set<CategoryId>();
  for (const m of prompt.matchAll(/(?:\{\{|｛｛)\s*本集\.(风格|光线)/g)) held.add(m[1] === "风格" ? "style" : "light");
  return held;
}

/** 「EP02-std-L03｜抬头等她过来」→「L03」。 */
const codeOf = (title: string) => { const head = title.split(/[｜|]/)[0].trim().replace(/·对比\d*[AB]$/, ""); const pair = /·对比(\d*)([AB])$/.exec(title); return (/([A-Za-z]*\d+[A-Za-z]?)$/.exec(head)?.[1] ?? head) + (pair ? `·${pair[1]}${pair[2]}` : ""); };

/**
 * 这一镜五项里不过的。h3qItems = 这一镜的 h3q 结果（给了就以 h3q 为准，空数组 = h3q 查过、五项都过）；
 * 不给就是画布兜底判定（已经算好的完整度结果可以直接传进来，省一遍判断）。五项都不看角色名，不需要角色库。
 */
export function shotGate(shot: ShotQueueShot, results?: readonly CategoryResult[], h3qItems?: readonly H3qItem[] | null): GateItem[] {
  if (h3qItems) {
    // 每一条单镜 ERROR 都拦：五项归成五个标签；其余按 lib/hard-rules.ts 的前缀表分组，表里没有的归「正本 h3q 写错」。
    const groups = new Map<string, { label: string; notes: string[] }>();
    for (const item of h3qItems) {
      if (item.level !== "ERROR" || h3qGateCategory(item.message)) continue;
      const rule = hardRuleOf(item.message) ?? OTHER_H3Q_ERROR;
      const note = "prefix" in rule ? item.message.replace(rule.prefix, "").trim() : item.message.trim();
      (groups.get(rule.id) ?? groups.set(rule.id, { label: rule.label, notes: [] }).get(rule.id)!).notes.push(note);
    }
    const fromH3q = [...h3qGateItems(h3qItems), ...[...groups].map(([id, group]) => ({ id, label: group.label, note: group.notes.join("；"), source: "h3q" as const }))];
    // 官方格式送声音：voiceRoleIds 人数和正文 <Audio N> 对不上——画布自己查（h3q 报了同一条就用 h3q 的）。
    const voice = officialVoiceItem(shot);
    return voice && !groups.has(OFFICIAL_VOICE_ID) ? [...fromH3q, voice] : fromH3q;
  }
  const all = results ?? shotCompleteness(shot, { visibleNames: [] });
  const held = placeheld(shot.prompt);
  const five: GateItem[] = all.filter((result) => isGateCategory(result.id) && result.state === "missing" && !held.has(result.id))
    .map((result) => ({ id: result.id, label: CATEGORY_BY_ID[result.id].label, note: result.note ?? CATEGORY_BY_ID[result.id].rule, source: "canvas" as const }));
  // 画布兜底只有五项和开场空白（表里 canvasFallback 的）；其他硬规则 h3q 没跑成时查不了，拦截原因里写明是兜底。
  const start = canvasOpeningGap(shot.prompt);
  const voice = officialVoiceItem(shot);
  return [...five, ...(start === null ? [] : [{ id: OPENING_GAP_ID, label: OPENING_GAP_LABEL, note: canvasOpeningGapNote(shot.title, start), source: "canvas" as const }]), ...(voice ? [voice] : [])];
}

/** 官方格式送声音的人数 / 编号对不上（lib/official-format.ts）。 */
function officialVoiceItem(shot: ShotQueueShot): GateItem | null {
  const problem = officialVoiceProblem(shot.prompt, shot.voiceRoleIds);
  return problem ? { id: OFFICIAL_VOICE_ID, label: OFFICIAL_VOICE_LABEL, note: problem, source: "canvas" } : null;
}

const isFive = (item: GateItem) => isGateCategory(item.id as CategoryId);
/** 拦的是什么：「画面五项」/「开场空白」/「画面五项、开场空白」…… */
const blockedWhat = (items: readonly GateItem[]) => [...new Set(items.map((item) => isFive(item) ? GATE_LABEL : item.label))].join("、");
/** 非五项的规则和改法（报错里写一次）。 */
const ruleLines = (items: readonly GateItem[]) => [...new Map(items.filter((item) => !isFive(item)).map((item) => [item.id, item])).values()]
  .map((item) => { const rule = hardRuleById(item.id); return rule ? `${item.label}：${rule.rule}，${rule.fixes}。` : ""; }).join("");

/** 拦截原因末尾说明是谁判的。 */
export const gateSourceNote = (basis?: GateBasis) => !basis ? "（画布完整度判定）" : basis.source === "h3q" ? "（正本 h3q 判定）" : `（画布兜底判定：正本 h3q 没用上——${basis.why}）`;

/** 卡片上这一镜「渲染这一镜」按钮的拦截原因；过了是空字符串。h3qItems / basis 同 shotGate / queueGate。 */
export function shotGateMessage(shot: ShotQueueShot, results?: readonly CategoryResult[], confirmed?: GateConfirmLookup, h3qItems?: readonly H3qItem[] | null, basis?: GateBasis) {
  const items = shotGate(shot, results, h3qItems);
  if (items.length && confirmationHolds(confirmed?.(shot), shot)) return "";
  const what = blockedWhat(items);
  return items.length ? `${what === GATE_LABEL ? `${GATE_LABEL}漏写或写错` : `${what}不过`}，不能渲染：${items.map((item) => item.label).join("、")}${basis ? gateSourceNote(basis) : h3qItems ? "（正本 h3q 判定）" : gateSourceNote()}。${ruleLines(items)}先在卡片里改好（点红框标签看要写什么），或点「我确认没问题」写理由` : "";
}

/**
 * 整集（或某一章）入队前：列出哪几镜哪项不过。chapter 从 0 数，不给就是整集。
 * confirmed：画布 store 里用户亲手确认过、正文没改的镜头放行。basis：h3q 报告（按队列顺序逐镜对上）或画布兜底；不给 = 画布判定。
 */
export function queueGate(queue: ShotQueue, chapter?: number, confirmed?: GateConfirmLookup, basis?: GateBasis) {
  const failures: GateFailure[] = [];
  const overridden: { title: string; reason: string }[] = [];
  let flat = 0;
  queue.chapters.forEach((part, c) => {
    part.shots.forEach((shot, s) => {
      const at = flat++;
      if (chapter !== undefined && c !== chapter) return;
      const items = shotGate(shot, undefined, basis?.source === "h3q" ? basis.report.shots[at] ?? [] : null);
      if (!items.length) return;
      const record = confirmed?.(shot);
      if (record && confirmationHolds(record, shot)) { overridden.push({ title: shot.title, reason: record.reason }); return; }
      failures.push({ chapter: c, index: s, title: shot.title, code: codeOf(shot.title), items });
    });
  });
  const list = failures.slice(0, 8).map((failure) => `${failure.code} ${failure.items.map((item) => item.label).join("、")}`).join("；");
  const all = failures.flatMap((failure) => failure.items);
  const message = failures.length ? `${blockedWhat(all)}${all.some(isFive) ? "（风格胶片、光线、景别焦段、构图、运镜机位）" : ""}有镜头不过，${chapter === undefined ? "整批" : "本章"}不提交：${list}${failures.length > 8 ? ` 等 ${failures.length} 镜` : ""}${gateSourceNote(basis)}。${ruleLines(all)}在镜头卡片里改好，或在那一镜点「我确认没问题」写理由，再入队。` : "";
  return { ok: failures.length === 0, failures, overridden, message, source: basis?.source ?? "canvas" as "h3q" | "canvas" };
}
