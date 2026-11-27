/**
 * 本集设定（用户 2026-11-11 确认格式，草案 docs/本集设定-格式草案.md）：队列顶层 `episode` 放风格、各场景光线句、画面要求、各场景环境底声；
 * 镜头正文写 `{{本集.风格}}`、`{{本集.光线.办公室}}`、`{{本集.画面要求}}`、`{{本集.底声.走廊}}`。
 * 读队列时先换回原句（纯文字替换，不加不减一个字），之后检查、卡片、提交、出片记录看到的都是换回后的正文。
 * 解析结果：shot.prompt = 换回后的正文，shot.promptTemplate = 带占位的原文（只有用了占位的镜头才有），queue.episode = 设定。
 * 写回 JSON 一律用 shotQueueJson（不要直接 JSON.stringify 解析结果）。规则必须和 h3q 一致（草案第 1.3、4 节）。
 */
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";
import { isOfficialFormat } from "./official-format.ts";

export interface EpisodeSettings {
  style?: string;
  lighting?: Record<string, string>;
  frameRequirements?: string;
  ambience?: Record<string, string>;
}
export type EpisodeField = keyof EpisodeSettings;
export const EPISODE_FIELDS: readonly EpisodeField[] = ["style", "lighting", "frameRequirements", "ambience"];
/** 占位里的中文名 ↔ JSON 字段。 */
export const FIELD_OF: Record<string, EpisodeField> = { 风格: "style", 光线: "lighting", 画面要求: "frameRequirements", 底声: "ambience" };
export const LABEL_OF: Record<EpisodeField, string> = { style: "风格", lighting: "光线", frameRequirements: "画面要求", ambience: "底声" };
const PER_SCENE = (field: EpisodeField) => field === "lighting" || field === "ambience";

const PLACEHOLDER = /\{\{本集\.([^{}]*)\}\}/g;
/** 写坏了的占位（单括号、全角括号、括号里有空格）：只认带「本集」的，不碰正文里别的大括号，旧队列不受影响。 */
const BROKEN = /\{\{\s*本集|｛｛\s*本集|\{本集\.|本集\.(?:风格|画面要求|光线|底声)/;
const TAG = /<\s*(?:Picture|Subject|Audio|Video)\s*\d*\s*>/i;
const SCENE_NAME = /^[^\s.{}｛｝]{1,20}$/;

/** h3q 的 EP_RESIDUE / EP_ANY：展开后还剩这些就是写坏了；prompt 以外出现就是写错地方。 */
const RESIDUE = /\{\{|\}\}|｛｛|｝｝|本集\./;
const MARK = /\{\{|｛｛|本集\./;
/** 和 h3q episode_prepare 的入口判断一样：有 episode，或队列里哪里写了「本集.」「｛｛本集」。 */
export const usesEpisode = (queue: unknown) => (queue as { episode?: unknown } | null)?.episode !== undefined || /本集\.|｛｛本集/.test(JSON.stringify(queue) ?? "");
/** 展开后的正文里还剩的残片（没有就是 null）。 */
export const episodeResidue = (text: string) => RESIDUE.exec(text)?.[0] ?? null;
/** 一个值里哪些位置的文字带占位记号：["title", "keyframe.prompt"]。 */
export function episodeMarkPaths(value: unknown, path: string): string[] {
  if (typeof value === "string") return MARK.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => episodeMarkPaths(item, `${path}.${i}`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => episodeMarkPaths(item, path ? `${path}.${key}` : key));
  return [];
}

export const hasPlaceholder = (text: string) => /\{\{本集\./.test(text);
export const placeholder = (field: EpisodeField, scene?: string) => `{{本集.${LABEL_OF[field]}${PER_SCENE(field) ? `.${scene}` : ""}}}`;

/** 「光线.办公室」→ 设定值；没有就 undefined。 */
export function episodeValue(episode: EpisodeSettings | undefined, key: string): string | undefined {
  const dot = key.indexOf(".");
  const field = FIELD_OF[dot < 0 ? key : key.slice(0, dot)];
  if (!field || !episode) return undefined;
  const value = episode[field];
  if (PER_SCENE(field)) return dot < 0 ? undefined : (value as Record<string, string> | undefined)?.[key.slice(dot + 1)];
  return dot < 0 && typeof value === "string" ? value : undefined;
}

/** 所有设定条目：[占位里的名字（光线.办公室）, 文字]。 */
export function episodeEntries(episode: EpisodeSettings | undefined): { key: string; field: EpisodeField; scene?: string; text: string }[] {
  if (!episode) return [];
  return EPISODE_FIELDS.flatMap((field) => {
    const value = episode[field];
    if (typeof value === "string") return [{ key: LABEL_OF[field], field, text: value }];
    if (value && typeof value === "object") return Object.entries(value).map(([scene, text]) => ({ key: `${LABEL_OF[field]}.${scene}`, field, scene, text }));
    return [];
  });
}

/** 校验 `episode`（第 1.3 节 3～6 条）。返回干净的设定和错误。 */
export function parseEpisodeSettings(value: unknown): { episode?: EpisodeSettings; errors: string[] } {
  if (value === undefined) return { errors: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { errors: ["episode（本集设定）必须是对象"] };
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  const extra = Object.keys(record).filter((key) => !(EPISODE_FIELDS as readonly string[]).includes(key));
  if (extra.length) errors.push(`episode（本集设定）只认 style / lighting / frameRequirements / ambience，多出：${extra.join("、")}`);
  const checkText = (text: unknown, where: string): text is string => {
    if (typeof text !== "string" || !text.length) { errors.push(`${where} 需要一段文字`); return false; }
    if (text !== text.trim()) errors.push(`${where} 开头或结尾有空格 / 换行，请删掉（看不见的差别会让每镜文字不一样）`);
    if (RESIDUE.test(text) || BROKEN.test(text)) errors.push(`${where} 里不能再写占位`);
    if (TAG.test(text)) errors.push(`${where} 里不能写 <Picture N> / <Subject N> 这类编号：每镜编号不一样，请写在镜头自己的正文里`);
    if (text.length > 4000) errors.push(`${where} 太长（超过 4000 字）`);
    return true;
  };
  const episode: EpisodeSettings = {};
  for (const field of EPISODE_FIELDS) {
    const raw = record[field];
    if (raw === undefined) continue;
    const where = `本集设定.${LABEL_OF[field]}`;
    if (!PER_SCENE(field)) { if (checkText(raw, where)) (episode as Record<string, unknown>)[field] = raw; continue; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${where} 必须是 { 场景名: 句子 }`); continue; }
    const scenes: Record<string, string> = {};
    for (const [scene, text] of Object.entries(raw as Record<string, unknown>)) {
      if (!SCENE_NAME.test(scene)) errors.push(`${where} 的场景名「${scene}」要 1～20 个字，不能有空格、点或大括号`);
      if (checkText(text, `${where}.${scene}`)) scenes[scene] = text;
    }
    (episode as Record<string, unknown>)[field] = scenes;
  }
  return { episode, errors };
}

/** 换回原句。错误：本集设定里没有这一项；换完还剩写坏的占位。 */
export function expandEpisode(prompt: string, episode: EpisodeSettings | undefined): { text: string; errors: string[]; used: string[] } {
  const errors: string[] = [], used: string[] = [];
  const text = prompt.replace(PLACEHOLDER, (whole, key: string) => {
    const value = episodeValue(episode, key);
    if (value === undefined) {
      const [kind] = key.split(".");
      const field = FIELD_OF[kind];
      const have = field ? episodeEntries(episode).filter((entry) => entry.field === field).map((entry) => entry.key) : [];
      errors.push(!episode ? `用了 ${whole}，但队列没有 episode（本集设定）` : `用了 ${whole}，本集设定里没有${have.length ? `；现有：${have.join("、")}` : field ? "这一类" : "（只认 风格 / 光线.场景 / 画面要求 / 底声.场景）"}`);
      return whole;
    }
    used.push(key);
    return value;
  });
  if (!errors.length && (BROKEN.test(text) || RESIDUE.test(text))) errors.push("占位写坏了（只认两层半角大括号，例如 {{本集.风格}}、{{本集.光线.办公室}}）");
  return { text, errors, used };
}

/** 一段正文按来源切开：literal 是镜头自己写的，key 是来自本集设定的那句。拼起来就是换回后的正文。 */
export function episodeSegments(template: string | undefined, episode: EpisodeSettings | undefined, prompt: string): { text: string; key?: string }[] {
  if (!template) return [{ text: prompt }];
  const out: { text: string; key?: string }[] = [];
  let at = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const value = episodeValue(episode, match[1]);
    if (value === undefined) continue;
    if (match.index! > at) out.push({ text: template.slice(at, match.index) });
    out.push({ text: value, key: match[1] });
    at = match.index! + match[0].length;
  }
  if (at < template.length) out.push({ text: template.slice(at) });
  return out.map((piece) => piece.text).join("") === prompt ? out : [{ text: prompt }];
}

/**
 * 正文改过以后，把原来用过的设定句在新正文里一字不差的地方换回占位；被改动的那句留成原文（这镜这一句脱离本集设定）。
 * 按原占位的先后顺序往后找，保证换回后的正文和传进来的一字不差。
 */
export function collapseEpisode(prompt: string, template: string, episode: EpisodeSettings | undefined): string {
  let out = "", at = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const value = episodeValue(episode, match[1]);
    if (!value) continue;
    const found = prompt.indexOf(value, at);
    if (found < 0) continue;
    out += prompt.slice(at, found) + match[0];
    at = found + value.length;
  }
  return out + prompt.slice(at);
}

/** 这镜写回 JSON 时的 prompt：没改过就是原模板，改过就重新收回；结果展开后一定等于 shot.prompt。 */
export function shotTemplate(shot: Pick<ShotQueueShot, "prompt" | "promptTemplate">, episode: EpisodeSettings | undefined): string {
  if (!shot.promptTemplate) return shot.prompt;
  const same = expandEpisode(shot.promptTemplate, episode);
  if (!same.errors.length && same.text.trim() === shot.prompt) return shot.promptTemplate;
  const collapsed = collapseEpisode(shot.prompt, shot.promptTemplate, episode);
  return expandEpisode(collapsed, episode).text === shot.prompt ? collapsed : shot.prompt;
}

const mapShots = (queue: ShotQueue, fn: (shot: ShotQueueShot) => ShotQueueShot): ShotQueue => ({ ...queue, chapters: queue.chapters.map((chapter) => ({ ...chapter, shots: chapter.shots.map(fn) })) });

/** 写回 JSON 的唯一入口：用了本集设定的镜头写占位版，不写 promptTemplate。旧队列输出和 JSON.stringify 一模一样。 */
export function shotQueueJson(queue: ShotQueue): string {
  const uses = Boolean(queue.episode) || queue.chapters.some((chapter) => chapter.shots.some((shot) => shot.promptTemplate !== undefined));
  if (!uses) return `${JSON.stringify(queue, null, 2)}\n`;
  const plain = mapShots(queue, (shot) => { const { promptTemplate: _drop, ...rest } = shot; void _drop; return { ...rest, prompt: shotTemplate(shot, queue.episode) }; });
  return `${JSON.stringify(plain, null, 2)}\n`;
}

/** 展开版（旧格式）：没有 episode、没有占位，给还不认识本集设定的工具（或现在的 h3q）用。 */
export function expandedQueueJson(queue: ShotQueue): string {
  const { episode: _drop, ...rest } = queue; void _drop;
  return `${JSON.stringify(mapShots(rest as ShotQueue, (shot) => { const { promptTemplate: _t, ...plain } = shot; void _t; return plain; }), null, 2)}\n`;
}

/** 改了本集设定：所有用占位的镜头重新换回正文。 */
export function withEpisode(queue: ShotQueue, episode: EpisodeSettings): ShotQueue {
  const next = mapShots(queue, (shot) => {
    if (!shot.promptTemplate) return shot;
    const template = shotTemplate(shot, queue.episode);
    if (!hasPlaceholder(template)) { const { promptTemplate: _t, ...plain } = shot; void _t; return { ...plain, prompt: template }; }
    return { ...shot, promptTemplate: template, prompt: expandEpisode(template, episode).text.trim() };
  });
  return { ...next, episode };
}

/** 场景改名：设定里的键和所有镜头的占位一起改。 */
export function renameEpisodeScene(queue: ShotQueue, field: "lighting" | "ambience", from: string, to: string): ShotQueue | string {
  const scenes = queue.episode?.[field];
  if (!scenes || !(from in scenes)) return `本集设定里没有「${from}」`;
  if (!SCENE_NAME.test(to)) return "场景名要 1～20 个字，不能有空格、点或大括号";
  if (to !== from && to in scenes) return `已经有叫「${to}」的场景`;
  const renamed = Object.fromEntries(Object.entries(scenes).map(([key, value]) => [key === from ? to : key, value]));
  const oldToken = placeholder(field, from), newToken = placeholder(field, to);
  const next = mapShots(queue, (shot) => shot.promptTemplate ? { ...shot, promptTemplate: shotTemplate(shot, queue.episode).split(oldToken).join(newToken) } : shot);
  return { ...next, episode: { ...queue.episode, [field]: renamed } };
}

/** 每条设定被哪些镜头用到。 */
export function episodeUsage(queue: ShotQueue): Map<string, string[]> {
  const usage = new Map<string, string[]>(episodeEntries(queue.episode).map((entry) => [entry.key, []]));
  for (const shot of queue.chapters.flatMap((chapter) => chapter.shots)) {
    if (!shot.promptTemplate) continue;
    for (const key of new Set(expandEpisode(shot.promptTemplate, queue.episode).used)) usage.get(key)?.push(shot.title);
  }
  return usage;
}

/**
 * h3q 把设定值里的问题只报一次、报在「本集设定.光线.办公室」上（h3q episode_merge），不挂在镜头上。
 * 卡片按镜头看 h3q 结果（画面五项也按镜头拦），所以把这些条目抄到每个用到这条设定的镜头上，消息原样（[五项·…] 标签不变），where 写明来自设定。
 * general 里的原条目保留（顶部「整集」照样显示）。没用本集设定的队列原样返回。
 */
type H3qLike = { where: string; message: string };
export function attachEpisodeH3qItems<R extends { shots: H3qLike[][]; general: H3qLike[] }>(report: R, queue: ShotQueue): R {
  if (!queue.episode) return report;
  const flat = queue.chapters.flatMap((chapter) => chapter.shots);
  const usedBy = flat.map((shot) => new Set(shot.promptTemplate ? expandEpisode(shot.promptTemplate, queue.episode).used : []));
  const fromSetting = report.general.flatMap((item) => { const m = /^本集设定\.(.+)$/.exec(item.where.trim()); return m ? [{ item, key: m[1] }] : []; });
  if (!fromSetting.length) return report;
  return { ...report, shots: report.shots.map((items, i) => [...items, ...fromSetting.filter(({ key }) => usedBy[i]?.has(key)).map(({ item, key }) => ({ ...item, where: `本集设定.${key}` }))]) };
}

// ── 找「本集设定那几类句子」：转换和「差一点」提示共用（草案第 3 节） ──
const SKIP = /^\s*(?:参考说明|主要动作|对白|台词|最终状态|声音|画面要求|\d+(?:\.\d+)?\s*[-–~～至到]\s*\d+(?:\.\d+)?\s*秒)/;
const FILM = /胶片|Kodak/i;
const LIGHTISH = /灯|光线|光照|照亮|曝光|色温|\d{4}\s*K|日光|月光|阳光|天光/;
const firstSentence = (text: string) => { const end = text.indexOf("。"); return end < 0 ? text : text.slice(0, end + 1); };
export interface Candidate { field: EpisodeField; line: number; start: number; text: string }
/** 一行里可能属于本集设定的那一段（只在句子边界上）。含占位的不算。 */
export function lineCandidate(line: string, index: number): Candidate | null {
  const pick = (field: EpisodeField, start: number, text: string) => text && !/\{\{|\}\}/.test(text) && !TAG.test(text) ? { field, line: index, start, text } : null;
  if (line.startsWith("画面要求：")) return pick("frameRequirements", 5, line.slice(5));
  if (line.startsWith("声音：")) return pick("ambience", 3, firstSentence(line.slice(3)));
  if (SKIP.test(line)) return null;
  const start = line.startsWith("光线：") ? 3 : 0;
  const body = line.slice(start), first = firstSentence(body);
  if (FILM.test(first)) return pick("style", start, first);
  if (LIGHTISH.test(first.replace(/目光|光着|光脚|光滑|光洁/g, ""))) return pick("lighting", start, body);
  return null;
}
// 官方格式（正本 v2026-11-13.1：官方格式不用 {{本集.…}} 占位，h3q [官方·本集设定] 报 ERROR）：不收、不提示「差一点」。
export const promptCandidates = (prompt: string) => isOfficialFormat(prompt) ? [] : prompt.split("\n").map(lineCandidate).filter((c): c is Candidate => c !== null);

/** 两句有多像：相同的开头 + 相同的结尾占较长那句的比例；一句（去掉句尾标点）整个含在另一句里、至少 6 个字的，也算差一点（0.5）。 */
export function likeness(a: string, b: string) {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const core = (text: string) => text.replace(/[。，；！？、\s]+$/u, "");
  const ca = core(a), cb = core(b);
  const contained = Math.min(ca.length, cb.length) >= 6 && (ca.includes(cb) || cb.includes(ca));
  return Math.max((head + tail) / max, contained ? 0.5 : 0);
}
/** 第一处不同前后几个字：「…照在张三的脸上…」。 */
export function diffSnippet(a: string, b: string) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cut = (text: string) => `…${text.slice(Math.max(0, i - 8), i + 14)}…`;
  return { shot: cut(a), setting: cut(b) };
}

export interface NearMiss { title: string; key: string; shot: string; setting: string }
/** 镜头里逐字照抄、但和本集设定差一点的句子（只提示，不改）。 */
export function episodeNearMisses(shot: Pick<ShotQueueShot, "title" | "prompt" | "promptTemplate">, episode: EpisodeSettings | undefined): NearMiss[] {
  if (!episode) return [];
  const entries = episodeEntries(episode);
  return promptCandidates(shot.promptTemplate ?? shot.prompt).flatMap((candidate) => {
    const pool = entries.filter((entry) => entry.field === candidate.field);
    if (!pool.length || pool.some((entry) => entry.text === candidate.text)) return [];
    const best = pool.reduce((a, b) => likeness(candidate.text, b.text) > likeness(candidate.text, a.text) ? b : a);
    if (likeness(candidate.text, best.text) < 0.5) return [];
    const snip = diffSnippet(candidate.text, best.text);
    return [{ title: shot.title, key: best.key, shot: snip.shot, setting: snip.setting }];
  });
}

/** 只提示：没人用的设定、差一点的照抄句。 */
export function episodeWarnings(queue: ShotQueue): string[] {
  if (!queue.episode) return [];
  const unused = [...episodeUsage(queue)].filter(([, titles]) => !titles.length).map(([key]) => `本集设定「${key}」整集没有一镜用到`);
  const near = queue.chapters.flatMap((chapter) => chapter.shots.flatMap((shot) => episodeNearMisses(shot, queue.episode)))
    .map((miss) => `「${miss.title}」这句和本集设定「${miss.key}」差一点（镜头里：${miss.shot}；设定：${miss.setting}），没有用占位`);
  return [...unused, ...near];
}

/** 章标题 → 场景名：「2-4｜办公室」→ 办公室；「2-4 张三办公室（标准队列实测）」→ 张三办公室。 */
export function sceneNameOf(title: string) {
  const raw = title.includes("｜") ? title.slice(title.indexOf("｜") + 1) : title.replace(/^\d+(?:-\d+)*\s*/, "");
  const name = raw.replace(/（[^）]*）|\([^)]*\)/g, "").replace(/[\s.{}｛｝]/g, "").slice(0, 20);
  return name || "场景";
}

export interface CollectResult {
  ok: boolean;
  /** 收进本集设定后的队列（解析结果的形状）；ok 为 false 时没有。 */
  queue?: ShotQueue;
  episode: EpisodeSettings;
  /** 占位 → 用到的镜头数 */
  used: Record<string, number>;
  /** 差一点、保留原文的 */
  kept: NearMiss[];
  error?: string;
}

/**
 * 转换：把逐字重复的句子收进本集设定（草案第 3 节）。每类（光线、底声按章分场景）取一字不差出现最多的那句；
 * 多于 1 镜的队列至少 2 镜一样才收。只换一字不差的，差一点的保留原文列在 kept。换完逐镜展开核对，有一镜不同就整个放弃。
 */
export function collectEpisode(queue: ShotQueue): CollectResult {
  const shots = queue.chapters.flatMap((chapter, c) => chapter.shots.map((shot) => ({ shot, c, template: shotTemplate(shot, queue.episode) })));
  const many = shots.length > 1;
  const counts = new Map<string, Map<string, number>>();
  for (const { c, template } of shots) for (const candidate of promptCandidates(template)) {
    const group = PER_SCENE(candidate.field) ? `${candidate.field}|${c}` : candidate.field;
    const bucket = counts.get(group) ?? new Map<string, number>(); counts.set(group, bucket);
    bucket.set(candidate.text, (bucket.get(candidate.text) ?? 0) + 1);
  }
  const best = (group: string) => { const bucket = counts.get(group); if (!bucket) return null; const [text, n] = [...bucket].reduce((a, b) => b[1] > a[1] ? b : a); return many && n < 2 ? null : text; };
  const episode: EpisodeSettings = structuredClone(queue.episode ?? {});
  for (const field of ["style", "frameRequirements"] as const) { const text = best(field); if (text && episode[field] === undefined) episode[field] = text; }
  for (const field of ["lighting", "ambience"] as const) {
    const scenes: Record<string, string> = { ...(episode[field] ?? {}) };
    queue.chapters.forEach((chapter, c) => {
      const text = best(`${field}|${c}`);
      if (!text || Object.values(scenes).includes(text)) return;
      let name = sceneNameOf(chapter.title), n = 2;
      while (name in scenes) name = `${sceneNameOf(chapter.title).slice(0, 18)}${n++}`;
      scenes[name] = text;
    });
    if (Object.keys(scenes).length) episode[field] = scenes;
  }
  const entries = episodeEntries(episode);
  const used: Record<string, number> = {};
  const kept: NearMiss[] = [];
  const failed: string[] = [];
  const sceneOrder = (c: number) => { const own = sceneNameOf(queue.chapters[c].title); return (a: { scene?: string }) => a.scene === own ? 0 : 1; };
  const next = { ...queue, episode, chapters: queue.chapters.map((chapter, c) => ({ ...chapter, shots: chapter.shots.map((shot) => {
    const lines = shotTemplate(shot, queue.episode).split("\n");
    const changed = lines.map((line, index) => {
      const candidate = lineCandidate(line, index);
      if (!candidate) return line;
      const pool = entries.filter((entry) => entry.field === candidate.field).sort((a, b) => sceneOrder(c)(a) - sceneOrder(c)(b));
      const hit = pool.find((entry) => entry.text === candidate.text);
      if (hit) { const token = placeholder(hit.field, hit.scene); used[token] = (used[token] ?? 0) + 1; return line.slice(0, candidate.start) + token + line.slice(candidate.start + candidate.text.length); }
      if (pool.length) {
        const near = pool.reduce((a, b) => likeness(candidate.text, b.text) > likeness(candidate.text, a.text) ? b : a);
        if (likeness(candidate.text, near.text) >= 0.5) { const snip = diffSnippet(candidate.text, near.text); kept.push({ title: shot.title, key: near.key, shot: snip.shot, setting: snip.setting }); }
      }
      return line;
    });
    const template = changed.join("\n");
    // 逐镜核对：换回来必须和原来的正文一字不差。
    const back = expandEpisode(template, episode);
    if (back.errors.length || back.text.trim() !== shot.prompt) failed.push(shot.title);
    if (!hasPlaceholder(template)) { const { promptTemplate: _t, ...plain } = shot; void _t; return plain; }
    return { ...shot, promptTemplate: template };
  }) })) };
  if (failed.length) return { ok: false, episode, used, kept, error: `「${failed[0]}」换回来和原文不一样，已放弃转换，队列没有改动` };
  if (!Object.keys(used).length) return { ok: false, episode, used, kept, error: "没有找到每镜逐字重复的风格 / 光线 / 画面要求 / 底声句，没什么可收" };
  // 只留真正用到的设定条目（原来就有的设定照留）。
  const trimmed: EpisodeSettings = {};
  for (const entry of episodeEntries(episode)) {
    if (!queue.episode && !used[placeholder(entry.field, entry.scene)]) continue;
    if (entry.scene === undefined) { (trimmed as Record<string, string>)[entry.field] = entry.text; continue; }
    const scenes = (trimmed[entry.field] as Record<string, string> | undefined) ?? {};
    scenes[entry.scene] = entry.text;
    (trimmed as Record<string, Record<string, string>>)[entry.field] = scenes;
  }
  return { ok: true, queue: { ...next, episode: trimmed }, episode: trimmed, used, kept };
}
