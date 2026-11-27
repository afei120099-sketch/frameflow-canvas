"use client";

import { useState, type ReactNode } from "react";
import { CATEGORY_BY_ID, PROMPT_CATEGORIES, ZHENGBEN_CATEGORY_VERSION, categoryTableStale, type CategoryId, type PromptCategory } from "@/lib/zhengben-categories";
import type { CategoryResult } from "@/lib/prompt-completeness";
import { GATE_LABEL, isGateCategory, type GateItem } from "@/lib/shot-gate";
import type { GateRowCtx } from "@/components/use-gate-confirmations";
import { TAGS_ALL_PASS, orderTags, tagsAllPass } from "@/lib/shot-card-view-rules";
import { hardRuleById } from "@/lib/hard-rules";

/**
 * 镜头卡片「提示词完整度」：每镜一排类别标签（写了 / 漏写 / 不适用），点开看正文原文；顶部整集汇总表。
 * 只标出来，不拦截入队。类别表在 lib/zhengben-categories.ts。样式只用 app/tokens.css 的灰阶。
 */

const STATE_LABEL = { ok: "写了", missing: "漏写", na: "不适用" } as const;

/** 画面五项这一镜的判定：by = h3q（正本 h3q 的 [五项·…] ERROR）/ canvas（h3q 没用上，画布兜底，why 说原因）/ pending（h3q 还在查，先按画布显示）。 */
export interface GateVerdict { failing: GateItem[]; by: "h3q" | "canvas" | "pending"; why?: string }
const VERDICT_NOTE = (verdict: GateVerdict) => verdict.by === "h3q" ? "正本 h3q 判定" : verdict.by === "pending" ? "正本 h3q 查着，先按画布判定" : `画布兜底判定（${verdict.why ?? "正本 h3q 没用上"}）`;

export function CompletenessRow({ results, extra, gate: gateCtx, verdict, fromEpisode }: { results: CategoryResult[]; extra?: (category: PromptCategory, result: CategoryResult) => ReactNode; gate?: GateRowCtx; verdict?: GateVerdict; /** 这几类的句子来自本集设定（标「本集」小字） */ fromEpisode?: ReadonlySet<CategoryId> }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [gateError, setGateError] = useState("");
  const [open, setOpen] = useState<CategoryId | null>(null);
  const [expanded, setExpanded] = useState(false);
  // 五项标签按判定显示：h3q 能跑就以 h3q 为准（画布没认出、h3q 说写对了的转成「写了」；h3q 说写错的转成红框，提示用 h3q 原话）。
  const failing = verdict ? new Map(verdict.failing.map((item) => [item.id, item])) : null;
  const shown = results.map((result): CategoryResult => {
    if (!failing || !isGateCategory(result.id)) return result;
    const item = failing.get(result.id);
    if (item) return { ...result, state: "missing", note: item.source === "h3q" ? `正本 h3q：${item.note}` : item.note };
    return result.state === "missing" ? { ...result, state: "ok", note: verdict!.by === "h3q" ? "正本 h3q 判定这项写对了（画布关键词没认出来）" : "用了本集设定占位，算写了（展开后的对错等 h3q 能跑时再查）" } : result;
  });
  const missing = shown.filter((result) => result.state === "missing").length;
  const current = open ? shown.find((result) => result.id === open) : undefined;
  const category = open ? CATEGORY_BY_ID[open] : undefined;
  // 画面五项·必写排最前、单独一组：漏写是红框，不写全这一镜不能入队；其余类别只提示。
  // 每组里漏写的排前面（lib/shot-card-view-rules.ts orderTags）。
  const gate = orderTags(shown.filter((result) => isGateCategory(result.id))), rest = orderTags(shown.filter((result) => !isGateCategory(result.id)));
  const gateMissing = gate.filter((result) => result.state === "missing").length;
  const confirmed = gateCtx?.confirmation ?? null;
  // 五项以外的硬拦（开场空白、表里没有的「正本 h3q 写错」……，lib/hard-rules.ts）：和五项同一套拦法、同一个「我确认没问题」，每组一行红字写原话、规则和改法。
  const hard = (verdict?.failing ?? []).filter((item) => !isGateCategory(item.id as CategoryId));
  const blocking = gateMissing > 0 || hard.length > 0;
  const tag = (result: CategoryResult) => <button type="button" role="listitem" key={result.id} className={`pc-tag ${result.state} ${isGateCategory(result.id) ? "gate" : ""} ${open === result.id ? "on" : ""}`} aria-expanded={open === result.id}
        title={`${CATEGORY_BY_ID[result.id].label}：${STATE_LABEL[result.state]}${result.note ? `｜${result.note}` : ""}（点开看原文${CATEGORY_BY_ID[result.id].preset ? "、选预设" : ""}）`}
        onClick={() => setOpen((value) => value === result.id ? null : result.id)}>
        <i aria-hidden>{result.state === "ok" ? "✓" : result.state === "missing" ? "!" : "–"}</i>{CATEGORY_BY_ID[result.id].label}{fromEpisode?.has(result.id) && <small className="pc-ep" title="这一类的句子来自本集设定"> 本集</small>}
      </button>;
  // 全过：整排收成一行灰字，点「看各项」再展开（有标签打开着、或在写放行理由时不收）。
  if (tagsAllPass(shown) && !hard.length && !expanded && !open && !asking) return <div className="pc-row pc-all-pass">
    <span className="pc-head">{TAGS_ALL_PASS}{verdict && <small title={verdict.why}> · {VERDICT_NOTE(verdict)}</small>}</span>
    <button type="button" className="pc-confirm-btn" aria-expanded="false" title="展开看每一类写了什么、选预设" onClick={() => setExpanded(true)}>看各项</button>
  </div>;
  return <div className="pc-row">
    {tagsAllPass(shown) && <button type="button" className="pc-confirm-btn pc-fold" onClick={() => { setExpanded(false); setOpen(null); }}>收成一行</button>}
    <div className={`pc-tags pc-gate ${confirmed ? "confirmed" : ""}`} role="list" aria-label={`${GATE_LABEL}·必写：漏写 ${gateMissing} 项`}>
      <span className={`pc-head ${gateMissing && !confirmed ? "bad" : ""}`}>{GATE_LABEL}·必写{gateMissing ? confirmed ? <em> {gateMissing} 项不过 · 已人工确认</em> : <b> {gateMissing} 项不过 · 不能入队</b> : <em> 写全了</em>}{verdict && <small title={verdict.why}> · {VERDICT_NOTE(verdict)}</small>}</span>
      {gate.map(tag)}
      {/* 只有用户在画布里亲手点、写理由才算数；只对现在这段正文有效，正文一改就失效（lib/shot-gate-confirm.ts）。 */}
      {blocking && gateCtx && (confirmed
        ? <><span className="pc-confirmed" title={`${confirmed.confirmedAt.slice(0, 16).replace("T", " ")} 确认；正文再改就失效，要重新确认`}>已人工确认：{confirmed.reason}</span><button type="button" className="pc-confirm-btn" onClick={() => void gateCtx.revoke()}>取消确认</button></>
        : !asking && <button type="button" className="pc-confirm-btn" title="写一句理由，这一镜就能入队；只对现在这段正文有效" onClick={() => { setAsking(true); setGateError(""); }}>我确认没问题</button>)}
    </div>
    {hard.map((item) => { const rule = hardRuleById(item.id); return <div key={item.id} className={`pc-gap ${confirmed ? "confirmed" : "bad"}`} role="alert">
      <b>{item.label} · {confirmed ? "已人工确认" : "不能入队"}</b>
      <span>{item.source === "h3q" ? "正本 h3q：" : "画布兜底判定（正本 h3q 没用上）："}{item.note}</span>
      {rule && <small>{rule.rule}{/①/.test(item.note) ? "。" : `。${rule.fixes}。`}</small>}
    </div>; })}
    {asking && gateCtx && !confirmed && <form className="pc-confirm-form" onSubmit={(event) => { event.preventDefault(); void gateCtx.confirm([...gate.filter((result) => result.state === "missing").map((result) => result.id), ...hard.map((item) => item.id)], reason).then((problem) => { if (problem) setGateError(problem); else { setAsking(false); setReason(""); } }); }}>
      <input className="sc-input" autoFocus value={reason} maxLength={200} placeholder="写一句理由（必填），例如：这一镜是黑场转场，不需要景别焦段" onChange={(event) => setReason(event.target.value)} />
      <button type="submit" className="sc-btn" disabled={!reason.trim()}>确认放行这一镜</button><button type="button" className="sc-btn" onClick={() => { setAsking(false); setGateError(""); }}>取消</button>
      {gateError && <em>{gateError}</em>}
    </form>}
    <div className="pc-tags" role="list" aria-label={`提示词完整度：漏写 ${missing - gateMissing} 类`}>
      <span className="pc-head">其他{missing - gateMissing ? <b> 漏 {missing - gateMissing}</b> : <em> 全写了</em>}<small> · 只提示</small></span>
      {rest.map(tag)}
    </div>
    {current && category && <div className="pc-detail">
      <header><b>{category.label}</b><span className={`pc-state ${current.state}`}>{STATE_LABEL[current.state]}</span><small>{category.source} · 正本 {ZHENGBEN_CATEGORY_VERSION}</small><button type="button" className="pc-close" onClick={() => setOpen(null)}>收起</button></header>
      <p className="pc-rule">要写：{category.rule}</p>
      {current.note && <p className="pc-note">{current.note}</p>}
      {current.evidence.length > 0 ? <div className="pc-quotes"><span>正文原文</span>{current.evidence.map((text, i) => <q key={i}>{text}</q>)}</div>
        : current.state !== "na" && <p className="pc-none">正文里没找到对应的句子。</p>}
      {extra?.(category, current)}
    </div>}
  </div>;
}

export interface SummaryRow { key: string; code: string; title: string; results: CategoryResult[] }

/** 整集汇总的一句话（顶栏下面那排小卡片里用）：几镜漏写、漏得最多的几类、类别表要不要同步。 */
export function completenessDigest(rows: SummaryRow[], currentVersion?: string, /** 用户在卡片里亲手确认过的镜头 */ confirmed?: (row: SummaryRow) => boolean, /** 五项不过（h3q 判定或画布兜底）；不给就按完整度结果 */ gateFails?: (row: SummaryRow) => boolean) {
  const lacking = rows.filter((row) => row.results.some((result) => result.state === "missing"));
  const perCategory = PROMPT_CATEGORIES.map((category) => ({ category, count: rows.filter((row) => row.results.find((result) => result.id === category.id)?.state === "missing").length })).filter((item) => item.count);
  const stale = categoryTableStale(currentVersion);
  // 正本比类别表新只在详情里灰字提一句，不进摘要、不改颜色（正本小版本常常规则没变）。
  const gateAll = rows.filter((row) => gateFails ? gateFails(row) : row.results.some((result) => isGateCategory(result.id) && result.state === "missing"));
  const gateShots = gateAll.filter((row) => !confirmed?.(row)), gateConfirmed = gateAll.length - gateShots.length;
  const gateText = gateShots.length ? `${GATE_LABEL}：${gateShots.length} 镜不过，不能入队${gateConfirmed ? `（另 ${gateConfirmed} 镜已人工确认）` : ""} · ` : gateConfirmed ? `${GATE_LABEL}：${gateConfirmed} 镜已人工确认 · ` : "";
  const text = gateText + (lacking.length ? `${lacking.length}/${rows.length} 镜有漏写${perCategory.length ? `（${perCategory.slice(0, 3).map(({ category, count }) => `${category.label} ${count}`).join("、")}${perCategory.length > 3 ? "…" : ""}）` : ""}` : `${rows.length} 镜都写全了`);
  return { lacking, perCategory, stale, text, gateShots, tone: gateShots.length ? "bad" as const : lacking.length ? "warn" as const : "plain" as const };
}

/** 整集汇总表：哪几镜漏了什么；每类漏了几镜。点镜头号跳到那一镜。点开顶栏下「提示词完整度」小卡片才显示。 */
export function CompletenessDetail({ rows, jump, currentVersion }: { rows: SummaryRow[]; jump: (key: string) => void; /** 正本现在的版本（h3q 那次读的） */ currentVersion?: string }) {
  const { lacking, perCategory, stale } = completenessDigest(rows, currentVersion);
  return <div className="pc-summary">
    <p className="pc-rule">按正本 {ZHENGBEN_CATEGORY_VERSION} 的第一集写法和细节清单逐镜判断「有没有写到」。<b>{GATE_LABEL}（风格胶片、光线、景别焦段、构图、运镜机位）是必写：一项漏写，这一镜就不能渲染，整集 / 本章入队和收件箱都整批不提交。</b>其余类别只标出来，不拦；写法对错以「正本 h3q」为准。</p>
    {stale && <p className="pc-quiet">类别表核对到正本 {ZHENGBEN_CATEGORY_VERSION}，正本现在是 {currentVersion}；正本只是小改时类别一般不变，有空再核对 lib/zhengben-categories.ts。</p>}
    {perCategory.length > 0 && <p className="pc-counts">{perCategory.map(({ category, count }) => <span key={category.id} title={category.rule}>{category.label} <b>{count}</b></span>)}</p>}
    {lacking.length > 0 ? <div className="pc-table-wrap"><table className="pc-table">
      <thead><tr><th>镜头</th><th>漏写</th></tr></thead>
      <tbody>{lacking.map((row) => <tr key={row.key}>
        <td><button type="button" onClick={() => jump(row.key)} title={row.title}>{row.code}</button></td>
        <td>{row.results.filter((result) => result.state === "missing").map((result) => <span key={result.id} className="pc-miss" title={result.note ?? CATEGORY_BY_ID[result.id].rule}>{CATEGORY_BY_ID[result.id].label}</span>)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="pc-none">每一镜每一类都写到了。</p>}
  </div>;
}

/** 完整度标签和汇总表的样式；由 shot-card-header.tsx 的 SC_HEADER_STYLE 一起挂上（卡片开着就一直在）。 */
export const COMPLETENESS_STYLE = () => STYLE;

const STYLE = `
.pc-row{grid-column:2/-1;display:flex;flex-direction:column;gap:8px;min-width:0}
.pc-row.pc-all-pass{flex-direction:row;align-items:center;gap:4px;color:var(--ff-text-3)}
.pc-all-pass .pc-head{color:var(--ff-text-3)}
.pc-row>.pc-fold{align-self:flex-start;margin-left:0}
.pc-tags{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.pc-head{margin-right:6px;font:12px var(--ff-mono);letter-spacing:.08em;color:var(--ff-text-3)}
.pc-head b{color:var(--ff-white);font-weight:600}.pc-head em{font-style:normal;color:var(--ff-text-2)}
.pc-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;border:1px solid var(--ff-border-soft);background:transparent;font-size:12px;line-height:18px;color:var(--ff-text-2);cursor:pointer}
.pc-tag i{font-style:normal;font:600 11px var(--ff-mono)}
.pc-tag.ok{border-color:var(--ff-border-soft);color:var(--ff-text-2)}.pc-tag.ok i{color:var(--ff-text-3)}
.pc-tag.missing{border-color:var(--ff-white);background:transparent;color:var(--ff-white);font-weight:600}
.pc-tag.na{border-style:dashed;color:var(--ff-text-4)}
.pc-tag.gate.missing{border-color:var(--ff-bad);background:transparent;color:var(--ff-bad);box-shadow:inset 0 0 0 1px var(--ff-bad)}
.pc-gate{padding-bottom:4px;border-bottom:1px dashed var(--ff-border-soft)}
.pc-gate.confirmed .pc-tag.gate.missing{border-color:var(--ff-border-strong);color:var(--ff-text-2);box-shadow:none;border-style:dashed}
.pc-gap{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-left:2px solid var(--ff-bad,#dc8a7c);font-size:12.5px;line-height:1.55;color:var(--ff-text-2)}
.pc-gap b{font-weight:600;color:var(--ff-bad,#dc8a7c)}.pc-gap span{color:var(--ff-text)}.pc-gap small{color:var(--ff-text-3);font-size:12px}
.pc-gap.confirmed{border-left-color:var(--ff-text-3)}.pc-gap.confirmed b{color:var(--ff-text-2)}
.pc-confirm-btn{margin-left:6px;padding:1px 10px;border:1px solid var(--ff-border-strong);border-radius:999px;background:transparent;font-size:12px;line-height:18px;color:var(--ff-text-2);cursor:pointer}
.pc-confirm-btn:hover{border-color:var(--ff-border-hover);color:var(--ff-text)}
.pc-confirmed{padding:1px 9px;border-radius:999px;background:var(--ff-raised);font-size:12px;line-height:18px;color:var(--ff-text-2);max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-confirm-form{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.pc-confirm-form .sc-input{flex:1 1 320px;padding:5px 10px}.pc-confirm-form em{flex-basis:100%;font-style:normal;color:var(--ff-bad);font-size:12px}
.pc-head.bad,.pc-head.bad b{color:var(--ff-bad)}.pc-head small{color:var(--ff-text-4)}
.pc-tag:hover{border-color:var(--ff-border-hover)}.pc-tag.missing:hover{background:var(--ff-raised)}
.pc-tag.on{box-shadow:0 0 0 2px var(--ff-text-3)}
.pc-detail{padding:10px 12px;border:1px solid var(--ff-border-strong);border-radius:10px;background:var(--ff-sunken);font-size:12.5px;line-height:1.6}
.pc-detail header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:4px}
.pc-detail header small{color:var(--ff-text-3);font:12px var(--ff-mono)}
.pc-close{margin-left:auto;padding:0 8px;border:1px solid var(--ff-border-soft);border-radius:999px;background:transparent;font-size:12px;color:var(--ff-text-3)}
.pc-state{padding:0 7px;border-radius:999px;border:1px solid var(--ff-border-soft);font-size:12px}
.pc-state.missing{color:var(--ff-white);border-color:var(--ff-white);font-weight:600}.pc-state.na{border-style:dashed;color:var(--ff-text-4)}
.pc-rule{margin:0;color:var(--ff-text-2)}.pc-note{margin:4px 0 0;color:var(--ff-white);font-weight:500}.pc-none{margin:4px 0 0;color:var(--ff-text-3)}
.pc-quotes{display:flex;flex-direction:column;gap:4px;margin-top:6px}.pc-quotes>span{font:12px var(--ff-mono);color:var(--ff-text-3)}
.pc-quotes q{display:block;padding:4px 10px;border-left:2px solid var(--ff-text-3);background:var(--ff-surface);color:var(--paper,var(--ff-text));quotes:none;word-break:break-all}
.pc-summary{font-size:12.5px;color:var(--paper,var(--ff-text))}
.pc-quiet{margin:6px 0 0;font-size:12px;color:var(--ff-text-3)}
.pc-counts{display:flex;flex-wrap:wrap;gap:6px 12px;margin:8px 0 0;color:var(--ff-text-2)}.pc-counts b{color:var(--ff-white);font-family:var(--ff-mono)}
.pc-table-wrap{max-height:240px;overflow:auto;margin-top:8px;border-top:1px solid var(--ff-border-soft)}
.pc-table{width:100%;border-collapse:collapse}
.pc-table th{position:sticky;top:0;background:var(--ff-surface);text-align:left;font:12px var(--ff-mono);color:var(--ff-text-3);padding:4px 6px}
.pc-table td{padding:4px 6px;border-top:1px solid var(--ff-border-soft);vertical-align:top}
.pc-table td:first-child{width:72px}
.pc-table button{padding:0 8px;border:1px solid var(--ff-border-strong);border-radius:999px;background:transparent;font:12px var(--ff-mono);color:var(--ff-text)}
.pc-miss{display:inline-block;margin:0 4px 3px 0;padding:0 7px;border:1px solid var(--ff-white);border-radius:999px;color:var(--ff-white);font-size:12px;line-height:16px}
`;
