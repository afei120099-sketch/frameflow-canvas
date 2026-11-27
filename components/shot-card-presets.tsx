"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchVocab } from "@/lib/zhengben-client";
import { cleanPresetText, locatePreset, planShotPreset, presetItems, PRESET_KIND_LABEL, SHOT_SIZES, type PresetEdit } from "@/lib/zhengben-presets";
import type { PresetKind, PromptCategory } from "@/lib/zhengben-categories";

/**
 * 一键选预设面板（在完整度标签里点开）：词库通过开发服务器实时读 %FRAMEFLOW_H3_TOOLS%\源文件\vocab.json，画布只读。
 * 选一条先看「原来 / 换成」，再点「只换本镜」或「整集都换」。替换就是改队列，照常进撤销 / 恢复。
 */
export interface PresetCtx {
  prompt: string;
  names: string[];
  locked: string;
  /** How many shots 整集都换 would change (this one included) and skip. */
  episodePlan: (edit: PresetEdit) => { changed: number; skipped: number };
  apply: (scope: "shot" | "episode", edit: PresetEdit) => Promise<string | null>;
}

const FAV_KEY = "frameflow.shotCard.presetFavorites.v1";
const readFavs = (): Record<string, string[]> => { try { return JSON.parse(localStorage.getItem(FAV_KEY) || "{}"); } catch { return {}; } };
const writeFavs = (value: Record<string, string[]>) => { try { localStorage.setItem(FAV_KEY, JSON.stringify(value)); } catch { /* per-browser convenience only */ } };

export function PresetPicker({ category, ctx }: { category: PromptCategory; ctx: PresetCtx }) {
  const kind = category.preset as PresetKind;
  const [vocab, setVocab] = useState<Record<string, unknown> | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [favs, setFavs] = useState<Record<string, string[]>>(readFavs);
  const [pending, setPending] = useState<{ edit: PresetEdit; name: string } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Read fresh each time the panel opens: the user may have just edited vocab.json.
  useEffect(() => { let active = true; void fetchVocab().then((result) => { if (!active) return; if (result.ok) setVocab(result.vocab); else setLoadError(result.error); }); return () => { active = false; }; }, []);
  const items = useMemo(() => presetItems(vocab, kind), [vocab, kind]);
  const favList = favs[kind] ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? items.filter((item) => (item.name + item.text).toLowerCase().includes(q)) : items;
    return [...list.filter((item) => favList.includes(item.name)), ...list.filter((item) => !favList.includes(item.name))];
  }, [items, query, favList]);
  const toggleFav = (name: string) => setFavs((current) => { const set = new Set(current[kind] ?? []); if (set.has(name)) set.delete(name); else set.add(name); const next = { ...current, [kind]: [...set] }; writeFavs(next); return next; });
  const choose = (edit: PresetEdit, name: string) => { setNote(""); setPending({ edit, name }); };
  const preview = pending ? planShotPreset(ctx.prompt, pending.edit) : null;
  const plan = pending ? ctx.episodePlan(pending.edit) : null;
  const target = locatePreset(ctx.prompt, kind);
  const go = async (scope: "shot" | "episode") => {
    if (!pending) return;
    setBusy(true);
    const problem = await ctx.apply(scope, pending.edit);
    setBusy(false);
    if (problem) setNote(problem); else { setNote(scope === "shot" ? "已换好，点上面「撤销」可以退回" : "整集已换好，点上面「撤销」可以退回"); setPending(null); }
  };

  return <div className="pp-panel">
    {category.id === "shotsize" && <div className="pp-quick"><span>景别</span>{SHOT_SIZES.map((size) => <button type="button" key={size} className={pending?.edit.kind === "size" && pending.edit.size === size ? "on" : ""} onClick={() => choose({ kind: "size", size }, size)}>{size}</button>)}</div>}
    <div className="pp-head">
      <span>从词库选{PRESET_KIND_LABEL[kind]}{items.length ? ` · ${items.length} 条` : ""}</span>
      <input className="sc-input" placeholder="搜索名称或内容" value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    <p className="pp-where">{target ? <>会替换：<q>{target.text}</q></> : "这一镜还没写这一类，选了会接在风格那一行末尾" + (kind === "light" ? "（光线句单独一行）" : "")}</p>
    {loadError ? <p className="pp-error">词库读不到：{loadError}</p> : !vocab ? <p className="pp-dim">正在读词库 vocab.json…</p> : <ul className="pp-list">
      {shown.slice(0, 60).map((item) => <li key={item.name} className={pending?.name === item.name ? "on" : ""}>
        <button type="button" className={`pp-fav ${favList.includes(item.name) ? "on" : ""}`} title={favList.includes(item.name) ? "取消常用" : "设为常用（排在最前，只记在这台电脑）"} onClick={() => toggleFav(item.name)}>{favList.includes(item.name) ? "★" : "☆"}</button>
        <button type="button" className="pp-item" onClick={() => choose({ kind, text: cleanPresetText(item.text, ctx.prompt, ctx.names) }, item.name)}><b>{item.name}</b><span>{cleanPresetText(item.text, ctx.prompt, ctx.names).slice(0, 70)}</span></button>
      </li>)}
      {shown.length > 60 && <li className="pp-dim">还有 {shown.length - 60} 条，搜索缩小范围</li>}
      {!shown.length && <li className="pp-dim">没有匹配的</li>}
    </ul>}
    {pending && preview && <div className="pp-preview">
      <p><span>原来</span>{preview.before ? <q>{preview.before}</q> : <em>（没有，新加）</em>}</p>
      <p><span>换成</span><q>{preview.after}</q></p>
      <small>已按正本清理：「主体」换成他 / 她（或删掉），不写人名，不点名配乐，去掉「开口 / 不出声」、定格、唯一光源这类句子。</small>
      <div className="pp-actions">
        <button type="button" className="sc-btn primary" disabled={busy || Boolean(ctx.locked)} title={ctx.locked || undefined} onClick={() => void go("shot")}>只换本镜</button>
        <button type="button" className="sc-btn" disabled={busy || Boolean(ctx.locked)} title={ctx.locked || "其他镜头里这一句和本镜一字不差的才一起换，写法不同的不动"} onClick={() => void go("episode")}>整集都换{plan ? `（${plan.changed} 镜同一句${plan.skipped ? `，${plan.skipped} 镜不同不动` : ""}）` : ""}</button>
        <button type="button" className="sc-btn" onClick={() => setPending(null)}>取消</button>
      </div>
    </div>}
    {note && <p className="pp-note" role="status">{note}</p>}
  </div>;
}

export const PRESET_STYLE = `
.pp-panel{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--ff-border-soft)}
.pp-quick{display:flex;flex-wrap:wrap;align-items:center;gap:4px}.pp-quick>span{margin-right:4px;font:12px var(--ff-mono);color:var(--ff-text-3)}
.pp-quick button{padding:2px 12px;border:1px solid var(--ff-border-strong);border-radius:999px;background:var(--ff-surface);font-size:12.5px;color:var(--ff-text)}
.pp-quick button:hover,.pp-quick button.on{background:var(--ff-white);color:var(--ff-ink);border-color:var(--ff-white)}
.pp-head{display:flex;align-items:center;gap:8px}.pp-head>span{flex:none;font:12px var(--ff-mono);color:var(--ff-text-3)}.pp-head input{flex:1;padding:4px 8px}
.pp-where{margin:0;font-size:12px;color:var(--ff-text-3)}.pp-where q,.pp-preview q{quotes:none;color:var(--ff-text)}
.pp-list{list-style:none;margin:0;padding:0;max-height:220px;overflow:auto;border:1px solid var(--ff-border-soft);border-radius:8px}
.pp-list li{display:flex;align-items:stretch;border-top:1px solid var(--ff-border-soft)}.pp-list li:first-child{border-top:0}
.pp-list li.on{background:var(--ff-hover)}
.pp-fav{flex:none;width:28px;border:0;background:transparent;color:var(--ff-text-3)}.pp-fav.on{color:var(--ff-white)}
.pp-item{flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:4px 8px;border:0;background:transparent;text-align:left;min-width:0}
.pp-item:hover{background:var(--ff-hover)}.pp-item b{font-weight:600;font-size:12.5px;color:var(--ff-text)}.pp-item span{font-size:12px;color:var(--ff-text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.pp-preview{padding:8px 10px;border:1px solid var(--ff-border-strong);border-radius:8px;background:var(--ff-surface)}
.pp-preview p{display:grid;grid-template-columns:36px 1fr;gap:6px;margin:0 0 4px}.pp-preview p>span{font:12px var(--ff-mono);color:var(--ff-text-3)}.pp-preview em{font-style:normal;color:var(--ff-text-3)}
.pp-preview small{display:block;color:var(--ff-text-3);font-size:12px}
.pp-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.pp-actions .sc-btn{padding:4px 10px;font-size:12px}
.pp-error{margin:0;color:var(--ff-white);font-weight:500}.pp-dim{margin:0;padding:4px 8px;color:var(--ff-text-3);font-size:12px}.pp-note{margin:0;color:var(--ff-text-2);font-size:12px}
`;
