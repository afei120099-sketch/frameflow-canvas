/**
 * 镜头卡片：把一条 H3 队列提示词拆成「剧情 / 运镜 / 画面 / 声音 / 对白 / 参考说明 / 画面要求」几格，只用于显示。
 * 提交给 H3 的永远是原始 prompt，这里不改写、不拼回。
 *
 * 认的写法（用户的固定标签）：
 *   参考说明（…）：…      → reference
 *   主要动作：…            → 剧情摘要
 *   0-2秒：… / [0s-2s] …   → 时间段，逐句分到 剧情 / 运镜 / 画面
 *   声音：… / 无任何对白…  → sound
 *   对白（…）：…           → dialogue
 *   画面要求：…            → requirements
 *   其余没有标签的段落      → look（画风、场景、道具）
 */

export type ClauseKind = "story" | "camera" | "look" | "sound" | "lip";
export const CLAUSE_KIND_LABEL: Record<ClauseKind, string> = { story: "剧情", camera: "运镜", look: "画面", sound: "声音", lip: "口型" };

export interface ShotBeat {
  /** "0–2秒"; for English "[0s-2s]" too. */
  range: string;
  start: number;
  end: number;
  story: string[];
  camera: string[];
  look: string[];
  sound: string[];
  lip: string[];
}

export interface ShotBreakdown {
  /** 主要动作 line, camera/look clauses removed. */
  summary: string[];
  beats: ShotBeat[];
  /** Clauses outside beats that are camera words (e.g. a "Static camera." sentence). */
  camera: string[];
  look: string[];
  sound: string[];
  lip: string[];
  dialogue: string[];
  reference: string;
  requirements: string;
  /** True when no known label was found: the card shows the prompt as one block. */
  unstructured: boolean;
}

/** User corrections: exact clause text → kind. Stored per browser by the card board. */
export type ClauseOverrides = Readonly<Record<string, ClauseKind>>;

const CAMERA = [
  // 景别
  "大特写", "特写", "近景", "中近景", "中景", "中全景", "全景", "远景", "大远景", "半身", "全身",
  // 角度 / 视点
  "低角度", "高角度", "仰拍", "俯拍", "仰角", "俯角", "平视", "鸟瞰", "顶拍", "侧拍", "背拍", "过肩", "主观镜头", "视线往", "视角", "POV",
  // 运动
  "推镜", "拉镜", "摇镜", "移镜", "跟拍", "跟镜", "环绕", "升降", "甩镜", "手持", "固定机位", "固定镜头", "镜头缓", "镜头慢", "镜头推", "镜头拉", "镜头跟", "镜头摇", "镜头移", "镜头", "机位", "运镜", "缓推", "慢推", "缓拉", "慢拉", "推近", "拉远", "横移", "前推", "后拉", "变焦", "焦点", "虚焦", "景深",
  // English
  "close-up", "close up", "extreme close", "medium shot", "wide shot", "full shot", "long shot", "establishing", "over-the-shoulder", "over the shoulder",
  "low angle", "high angle", "low-angle", "high-angle", "bird's-eye", "top-down", "eye level", "eye-level", "push-in", "push in", "pull back", "pull-back", "dolly", "tracking", "track ", "pan ", "panning", "tilt up", "tilt down", "tilts up", "tilts down", "orbit", "crane", "handheld", "hand-held", "static camera", "static shot", "locked-off", "zoom", "rack focus", "camera",
  "medium close-up", "35mm", "50mm", "85mm", "24mm", "lens", "focus", "from under", "from above", "from below",
];
const LOOK = [
  "光", "灯", "阴天", "晴天", "雨", "雪", "雾", "烟", "夜色", "黄昏", "清晨", "窗外", "天色", "色调", "背景", "氛围", "质感", "胶片", "颗粒", "Kodak", "影调", "暗部", "高光", "阴影", "剪影", "轮廓", "曝光",
  "light", "lit ", "lighting", "lamp", "sunlight", "shadow", "silhouette", "backlit", "overcast", "rain", "fog", "mist", "dusk", "dawn", "night", "film grain", "color grade", "exposure", "photoreal", "skin pores", "fabric", "realism", "[style",
];
const SOUND = ["声音", "音效", "环境声", "脚步声", "键盘声", "空调声", "风声", "雨声", "配乐", "音乐", "旁白", "无对白", "无人说话", "sound", "ambience", "ambient", "room tone", "footsteps", "music", "voice is"];
/** Lip-sync boilerplate the H3 template asks for: not story. */
const LIP = /\blips?\b|\bmouth\b|stays? silent|three-quarter to camera|口型|闭嘴|嘴唇|双唇/i;
/** Fixed closing sentences of the 范本 format. */
const REQUIREMENT = /^(after the last word|one continuous take|no extra people|any logos|apart from that one caption|最后一个字说完|一条镜头拍完)/i;
/** Opening positions in an unlabelled paragraph: "张三在画左…坐在椅子上". Goes to the 开始 row. */
const STAGING = /[在从]画[左右]|画面[左右]侧|坐在|站在|靠在|躺在|蹲在|跪在|is frame (?:left|right)|stands? (?:at|by|on)|(?:is )?seated/i;
/** A bare angle word is a camera note: 仰 / 俯 / 侧 / 平视. */
const BARE_ANGLE = /^(仰|俯|侧|平|正|背|斜|仰视|俯视|平视|侧面|正面)$/;

/** Words that contain a keyword but describe action: 目光 is a gaze, not lighting. */
const ACTION_WORDS = /目光|光着|光脚|眼光|看镜头|看向镜头|对着镜头|背对镜头|面向镜头|朝镜头|走向镜头|走出镜头|走出画面|tilts? (?:her|his|their) head|looks? (?:up |down )?at the camera/gi;
const escapeRe = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** English keywords match at a word start ("slightly" is not "light"); Chinese ones anywhere. */
const keywordRe = (words: readonly string[]) => new RegExp(words.map((word) => /^[\x00-\x7f]+$/.test(word) ? `(?<![a-z])${escapeRe(word.toLowerCase())}` : escapeRe(word)).join("|"), "i");
const CAMERA_RE = keywordRe(CAMERA), LOOK_RE = keywordRe(LOOK), SOUND_RE = keywordRe(SOUND);
const hasAny = (text: string, re: RegExp) => re.test(text.replace(ACTION_WORDS, ""));

/** Default classification of one clause. Lip first, then camera over look: "低角度近景…逆光" is a framing note first. */
/** Someone doing something to an object: stays in the story even if the object is a lamp or curtain. */
const HAND_VERB = /把.{0,8}(?:关|开|拉|推|拿|放|递|按|拧|拔)|(?:关掉|打开|拉开|拉上|按下|拿起|放下|伸手|抬手)|\b(?:turns? (?:off|on)|switch(?:es)? (?:off|on)|picks? up|puts? down|reaches? for)\b/i;

export function classifyClause(clause: string, overrides: ClauseOverrides = {}): ClauseKind {
  const key = clause.trim();
  if (overrides[key]) return overrides[key];
  if (BARE_ANGLE.test(key)) return "camera";
  if (LIP.test(key)) return "lip";
  if (hasAny(key, CAMERA_RE)) return "camera";
  if (hasAny(key, SOUND_RE)) return "sound";
  // "她把灯关掉" is an action on a lamp, not lighting description.
  if (HAND_VERB.test(key)) return "story";
  if (hasAny(key, LOOK_RE)) return "look";
  return "story";
}

/** Split a sentence into clauses on Chinese/English punctuation, keeping quoted speech in one piece. */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    // 9:16, 3:4 and 0.5 stay whole.
    if ((char === ":" || char === "：" || char === ",") && /\d/.test(chars[i - 1] ?? "") && /\d/.test(chars[i + 1] ?? "")) { current += char; continue; }
    if (char === "“" || char === "「" || char === "『") quote++;
    if ((char === "”" || char === "」" || char === "』") && quote > 0) quote--;
    if (!quote && /[，,。；;：:!！?？\n]/.test(char)) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    // English sentence end: ". " — not decimals like 0.5.
    if (!quote && char === " " && /[a-z)\]]\.$/i.test(current)) {
      if (current.trim()) out.push(current.trim().replace(/\.$/, ""));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim().replace(/\.$/, ""));
  // "他说话时，李四嘴唇闭着" is one thought: a clause ending in 时 / 的时候 joins the next.
  const merged: string[] = [];
  for (const clause of out.filter((item) => /[\p{L}\p{N}]/u.test(item))) {
    const previous = merged[merged.length - 1];
    if (previous && /(时|的时候|之后|以后)$/.test(previous)) merged[merged.length - 1] = `${previous}，${clause}`;
    else merged.push(clause);
  }
  return merged;
}

/** English sentences only (six-part format), so "frame left, three-quarter face, seated" stays one clause. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z<0-9])/).map((s) => s.trim().replace(/\.$/, "")).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const LABEL = /^\s*(参考说明|主要动作|核心动作|主要剧情|剧情|声音|音效|对白|台词|画面要求|画面约束|最终状态)\s*(?:（[^）]*）|\([^)]*\))?\s*[:：]\s*/;
const SECTION = /^\s*(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|integrated_multimodal_description)\s*:\s*/i;
const RANGE_ZH = /^\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[:：]?\s*/i;
const RANGE_BRACKET = /^\[\s*(\d+(?:\.\d+)?)\s*s?\s*[-–—~]\s*(\d+(?:\.\d+)?)\s*s\s*\]\s*/i;
/** 00:00-03:00, the 范本 time segments: seconds:frames-or-hundredths, never minutes (a shot is 5–15 s). */
const RANGE_CLOCK = /^(\d{1,2}):(\d{2})(?:\.\d+)?\s*[-–—~]\s*(\d{1,2}):(\d{2})(?:\.\d+)?\s*[:：]?\s*/;
const START_STATE = /^Already in motion at 00:00\s*[:：]\s*/i;

const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
type Buckets = Pick<ShotBeat, "story" | "camera" | "look" | "sound" | "lip">;

function sortClauses(target: Buckets, clauses: string[], overrides: ClauseOverrides, finalPrefix = "") {
  for (const clause of clauses) {
    if (/^最终状态$/.test(clause)) continue;
    const kind = classifyClause(clause, overrides);
    target[kind].push(kind === "story" && finalPrefix ? `${finalPrefix}${clause}` : clause);
  }
}
const isEnglish = (text: string) => !/[㐀-鿿]/.test(text.replace(/<d>[\s\S]*?<\/d>/g, ""));
/** English: keep plain action sentences whole; a sentence that mixes in camera/light/lip words is split at commas. */
const clausesOf = (text: string) => isEnglish(text) ? splitSentences(text).flatMap((sentence) => classifyClause(sentence) === "story" ? [sentence] : splitClauses(sentence)) : splitClauses(text);

/** Lines of the prompt; time markers and the 范本 fixed sentences start a new line so each stands alone. */
function promptLines(prompt: string) {
  return prompt.replace(/\r\n?/g, "\n")
    .replace(/\[\s*\d+(?:\.\d+)?\s*s?\s*[-–—~]\s*\d+(?:\.\d+)?\s*s\s*\]/gi, (match) => `\n${match}`)
    .replace(/(?<![\d:])\d{1,2}:\d{2}(?:\.\d+)?\s*[-–—~]\s*\d{1,2}:\d{2}(?:\.\d+)?/g, (match) => `\n${match}`)
    .replace(/Already in motion at 00:00\s*[:：]/gi, (match) => `\n${match}`)
    .replace(/(After the last word|One continuous take|No extra people|Any logos)/g, (match) => `\n${match}`)
    .split("\n").map((line) => line.trim()).filter(Boolean);
}

export function breakdownShotPrompt(prompt: string, overrides: ClauseOverrides = {}): ShotBreakdown {
  const result: ShotBreakdown = { summary: [], beats: [], camera: [], look: [], sound: [], lip: [], dialogue: [], reference: "", requirements: "", unstructured: true };
  const loose: Buckets = { story: result.summary, camera: result.camera, look: result.look, sound: result.sound, lip: result.lip };
  let lastBeat: ShotBeat | null = null;
  const addRequirement = (text: string) => { result.requirements = result.requirements ? `${result.requirements} ${text}` : text; };
  for (const raw of promptLines(prompt)) {
    let line = raw;
    const section = SECTION.exec(line);
    if (section) {
      result.unstructured = false;
      const body = line.slice(section[0].length).trim();
      const name = section[1].toLowerCase();
      lastBeat = null;
      if (name === "subject_definitions") { result.reference = body; continue; }
      if (name === "retention_analysis") { result.reference = result.reference ? `${result.reference}\n${body}` : body; continue; }
      if (name === "summary") { sortClauses(loose, clausesOf(body.replace(/^\[[^\]]*\]\s*/, "")), overrides); continue; }
      if (name === "overall_soundscape") { result.sound.push(...clausesOf(body)); continue; }
      if (name === "non_diegetic_music") { result.sound.push(`音乐：${body || "N/A"}`); continue; }
      // detailed_description / integrated_*: the preamble (style, light, framing) is an unlabelled paragraph.
      line = body;
      if (!line) continue;
    }
    const clock = RANGE_CLOCK.exec(line);
    const plain = clock ? null : RANGE_BRACKET.exec(line) ?? RANGE_ZH.exec(line);
    if (clock || plain) {
      result.unstructured = false;
      const start = clock ? Number(clock[1]) + Number(clock[2]) / 100 : Number(plain![1]);
      const end = clock ? Number(clock[3]) + Number(clock[4]) / 100 : Number(plain![2]);
      const beat: ShotBeat = { range: `${fmt(start)}–${fmt(end)}秒`, start, end, story: [], camera: [], look: [], sound: [], lip: [] };
      // "…。最终状态：…" inside a beat stays with the beat as story.
      const [action, final] = line.slice((clock ?? plain)![0].length).split(/最终状态\s*[:：]/);
      sortClauses(beat, clausesOf(action), overrides);
      if (final?.trim()) sortClauses(beat, clausesOf(final), overrides, "最终：");
      result.beats.push(beat); lastBeat = beat;
      continue;
    }
    const startState = START_STATE.exec(line);
    if (startState) {
      result.unstructured = false;
      const beat: ShotBeat = { range: "开始", start: -1, end: 0, story: [], camera: [], look: [], sound: [], lip: [] };
      sortClauses(beat, clausesOf(line.slice(startState[0].length)), overrides);
      result.beats.push(beat); lastBeat = null;
      continue;
    }
    if (REQUIREMENT.test(line)) { addRequirement(line); lastBeat = null; continue; }
    const label = LABEL.exec(line);
    if (label) {
      result.unstructured = false;
      const body = line.slice(label[0].length).trim();
      switch (label[1]) {
        case "参考说明": result.reference = body; break;
        case "主要动作": case "核心动作": case "主要剧情": case "剧情": sortClauses(loose, clausesOf(body), overrides); break;
        case "最终状态": sortClauses(lastBeat ?? loose, clausesOf(body), overrides, "最终："); break;
        case "声音": case "音效": result.sound.push(...splitClauses(body)); break;
        case "对白": case "台词": result.dialogue.push(...dialogueLines(body)); break;
        case "画面要求": case "画面约束": result.requirements = body; break;
      }
      if (label[1] !== "最终状态") lastBeat = null;
      continue;
    }
    // English lead sentence of queue prompts.
    if (/^<Picture\s*\d+>\s*is the first frame/i.test(line)) result.unstructured = false;
    if (/^(无任何对白|无对白|无人说话|没有对白|No background music)/i.test(line)) { result.sound.push(line.replace(/[。.]$/, "")); lastBeat = null; continue; }
    // An unlabelled line straight after the last time segment is how that segment ends ("她这句已经说完，人留在画右").
    if (lastBeat) { sortClauses(lastBeat, clausesOf(line), overrides, "最终："); continue; }
    // Unlabelled paragraph: look/scene/props, with camera and sound sentences pulled out.
    // Positions ("张三在画左…坐在椅子上") go to the 开始 row; other story only if the user moved it there.
    let opening = result.beats.find((beat) => beat.range === "开始");
    const sentences = isEnglish(line) ? [line] : line.split(/(?<=[。；;])/);
    for (const sentence of sentences) {
      const positional = !isEnglish(sentence) && STAGING.test(sentence) && !LOOK_RE.test(sentence.replace(ACTION_WORDS, ""));
      if (positional) {
        if (!opening) { opening = { range: "开始", start: -1, end: 0, story: [], camera: [], look: [], sound: [], lip: [] }; result.beats.push(opening); }
        sortClauses(opening, clausesOf(sentence), overrides);
        continue;
      }
      for (const clause of clausesOf(sentence)) {
      const kind = classifyClause(clause, overrides);
      if (kind === "camera") result.camera.push(clause);
      else if (kind === "sound") result.sound.push(clause);
      else if (kind === "lip") result.lip.push(clause);
      else if (kind === "story" && overrides[clause.trim()] === "story") result.summary.push(clause);
      else if (kind === "story" && STAGING.test(clause)) {
        if (!opening) { opening = { range: "开始", start: -1, end: 0, story: [], camera: [], look: [], sound: [], lip: [] }; result.beats.push(opening); }
        opening.story.push(clause);
      } else result.look.push(clause);
      }
    }
  }
  result.beats.sort((a, b) => a.start - b.start);
  // A STAGING line that only says where the scenery is ("玻璃门在画中后景") stays in 画面 by the rule above.
  return result;
}

/** 对白 body → one line per speaker: 小刘（得意）："……" 李四（淡）："……" */
export function dialogueLines(body: string): string[] {
  const parts = body.split(/(?<=[”」"])\s*/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [body];
}

/** Camera per timed beat for the 运镜 box; a beat without camera words reads「未写运镜」. */
export function cameraTimeline(breakdown: ShotBreakdown) {
  return breakdown.beats.filter((beat) => beat.start >= 0).map((beat) => ({ range: beat.range, camera: beat.camera.join(" · ") }));
}

/** Story lines for the 剧情 box: each beat's story only. */
export function storyTimeline(breakdown: ShotBreakdown) {
  return breakdown.beats.map((beat) => ({ range: beat.range, story: beat.story.join("，") })).filter((beat) => beat.story);
}

/** "Subject 1" / "<Subject 2>" → role names, for display only. */
export function nameSubjects(text: string, names: readonly string[]) {
  return text.replace(/<?Subject\s*(\d+)>?/g, (match, n: string) => names[Number(n) - 1] ?? match);
}

/** One editable piece of the prompt: an exact substring of the original, in order. */
export interface PromptSegment { label: string; text: string }
const SECTION_LABEL: Record<string, string> = { subject_definitions: "参考说明", summary: "主要动作", retention_analysis: "保留说明", detailed_description: "画面", overall_soundscape: "声音", non_diegetic_music: "音乐", integrated_multimodal_description: "画面" };

/** The prompt cut where the card cuts it (labels, time segments, 开始, fixed endings). Joining the texts back with the original gaps gives the prompt unchanged. */
export function promptSegments(prompt: string): PromptSegment[] {
  return promptLines(prompt).map((text) => {
    const section = SECTION.exec(text);
    if (section) return { label: SECTION_LABEL[section[1].toLowerCase()] ?? section[1], text };
    const clock = RANGE_CLOCK.exec(text);
    if (clock) return { label: `${fmt(Number(clock[1]) + Number(clock[2]) / 100)}–${fmt(Number(clock[3]) + Number(clock[4]) / 100)}秒`, text };
    const plain = RANGE_BRACKET.exec(text) ?? RANGE_ZH.exec(text);
    if (plain) return { label: `${fmt(Number(plain[1]))}–${fmt(Number(plain[2]))}秒`, text };
    if (START_STATE.test(text)) return { label: "开始", text };
    if (REQUIREMENT.test(text)) return { label: "结尾", text };
    const label = LABEL.exec(text);
    if (label) return { label: label[1], text };
    return { label: "正文", text };
  });
}

/** Put edited segment texts back into the prompt; everything between segments (newlines, spaces) is kept as it was. */
export function replaceSegments(prompt: string, segments: readonly PromptSegment[], texts: readonly string[]): string {
  let out = "", cursor = 0;
  segments.forEach((segment, i) => {
    const at = prompt.indexOf(segment.text, cursor);
    if (at < 0) throw new Error(`提示词第 ${i + 1} 段对不上原文，没有保存`);
    out += prompt.slice(cursor, at) + texts[i];
    cursor = at + segment.text.length;
  });
  return out + prompt.slice(cursor);
}
