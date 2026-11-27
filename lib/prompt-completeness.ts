/**
 * 提示词完整度：按 lib/zhengben-categories.ts 的类别表，逐镜判断每一类「写了 / 漏写 / 不适用」，并给出正文里对应的原文。
 * 只读、不改提示词、不拦截入队。靠关键词判断，会有误报；拿不准的写在 note 里。
 * 规则对错以正本 h3q check 为准，这里只看「有没有写到」。
 */
import { PROMPT_CATEGORIES, type CategoryId } from "./zhengben-categories.ts";
import { parseDialogueRow } from "./dialogue-row.ts";
import { getActualDuration } from "./comfyui/h3-parameters.ts";
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";
import { isOfficialFormat, officialFiveText, OFFICIAL_FIVE } from "./official-format.ts";

export type CompletenessState = "ok" | "missing" | "na";
export interface CategoryResult { id: CategoryId; state: CompletenessState; evidence: string[]; note?: string }

export interface CompletenessContext {
  /** Names of the roles that appear on screen (roleIds order, offscreen ones left out). */
  visibleNames: string[];
  /** All role names of the shot (for 对白 / 参考说明). */
  roleNames?: string[];
  /** The shot right before this one in the queue (any chapter), for 镜间衔接. */
  previous?: ShotQueueShot | null;
  /** 画面要求 line most shots of the episode use; set only when the episode has two or more shots. */
  episodeRequire?: string | null;
}

// ── 行的分类 ──
const REF_LINE = /^\s*参考说明/;
const REQUIRE_LINE = /^\s*画面要求/;
const DIALOGUE_LINE = /^\s*(?:对白|台词)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]/;
const SOUND_LINE = /^\s*声音\s*[：:]/;
const MAIN_LINE = /^\s*主要动作\s*[：:]/;
const BEAT_LINE = /^\s*(\d+(?:\.\d+)?)\s*[-–~～至到]\s*(\d+(?:\.\d+)?)\s*秒\s*[：:]?/;

// ── 关键词 ──
const FILM = /胶片|颗粒|Kodak|柯达|Fuji|富士|Vision\s?3|Portra|Ektachrome|Cinestill|film grain|film stock|35mm 电影|电影色彩|色彩科学|调色|色调|色彩/i;
const SCENE = /场景|房间|办公室|会议室|客厅|卧室|厨房|茶水间|走廊|大厅|街|巷|门|窗|桌|椅|床|墙|地面|地板|山|林|殿|院|楼|店|车|屋|厅|室|湖|河|海|天空|office|room|street|hall/i;
const PROP_ACTION = /拿着|拿起|握着|握住|捏着|攥着|手里|递给|递过|接过|端着|托着|举着|提着|抱着|holds?\b|holding|picks? up|in (?:his|her|their) hand/i;
const VISIBLE = /清晰可见|clearly visible/i;
const LIGHT = /光|灯|日照|阳光|月光|light|lamp|sun|window glow/i;
const SIZE = /大特写|中近景|中全景|大远景|特写|近景|中景|全景|远景|close.?up|medium(?: close)? shot|wide shot|full shot|long shot|two.?shot|waist|chest.?up|head and shoulders|knees up|cowboy shot|full.?length|over.the.shoulder|过肩/i;
const LENS = /\d{2,3}\s*(?:mm|毫米)|焦段|广角|长焦|标准镜头|lens\b/i;
const DOF = /景深|虚化|焦外|散景|depth of field|out of focus|bokeh/i;
const COMPOSE = /三分之一|黄金|居中|画面中央|画中|画面中心|对称|留白|构图|前景|后景|背景|third|golden|cent(?:re|er) of (?:the )?frame|foreground|background|画左|画右/i;
const POSITION = /画左|画右|画中|画面左|画面右|画面中|左侧|右侧|前景|后景|frame.?left|frame.?right|screen.?left|screen.?right/i;
const FACING = /侧脸|正脸|侧身|背对|背向|背影|面向|面对|朝向|朝着|转身|四分之三|三分之四|正面|profile|facing|back to (?:the )?camera|three.?quarter/i;
const DISTANCE = /一臂|两步|三步|一步|隔着|相距|距离|米远|步远|身边|旁边|对面|面对面|并肩|贴近|靠近|之间|arm'?s length|apart|across the/i;
const CAMERA = /机位|仰拍|俯拍|平拍|平视|固定镜头|镜头固定|镜头不动|推近|推镜|缓推|慢推|前推|拉远|后拉|镜头拉|跟拍|跟随|跟着|摇镜|横移|平移|升降|手持|环绕|航拍|dolly|push.?in|pull.?(?:back|out)|tracking|\bpan\b|tilt|static camera|locked.?off|handheld|orbit|crane/i;
const PERF = /下颌|下巴|眉|眨眼|呼吸|屏息|屏住|屏气|看向|看着|望向|盯着|扫一眼|目光|视线|吞咽|喉结|手指(?:收紧|蜷|攥)|攥紧|握紧|肩膀|眼神|眼眶|泪|瞥|笑|皱眉|抿嘴|咬唇|咬牙|重心|点头|摇头|嘴角|脸红|垂眼|垂眸|抬眼|低头|挑眉|愣|怔|僵|颤|叹气|深吸|侧头|歪头|表情|神情|脸色|jaw|brow|blink|breath|exhal|inhal|swallow|grip|shoulders?|glanc|smile|frown|purse|tighten|weight shift|nods?/i;
const HAND = /手|拿|握|捏|攥|递|接过|端着|托着|扶着|按住|按着|抓|hand|holding|grip/i;
const SIDE = /左手|右手|双手|两手|两只手|左腕|右腕|left hand|right hand|both hands/i;
const ACTION_SOUND = /(?:纸|页|椅|杯|门|脚步|鞋|衣|布|键盘|笔|手|指|桌|碗|筷|瓶|水|刀|剑|碰|放|拿|翻|推|拉|关|开|走|敲|擦|摩擦|拖)[^，。；]{0,8}(?:声|响)|轻响|闷响|脆响|吱|沙沙|咔|嗒|窸窣|makes no sound|没有声音/i;
const TOGETHER = /两人|两个人|二人|彼此|他们|她们|对视/;

const sentences = (text: string) => text.split(/(?<=[。；;！？!?]|\.\s)/).map((piece) => piece.trim()).filter(Boolean);
const clauses = (text: string) => text.split(/[，,。；;！？!?\n]/).map((piece) => piece.trim()).filter(Boolean);

export interface PromptLines {
  all: string[]; reference: string[]; require: string[]; dialogue: string[]; sound: string[]; main: string[];
  beats: { line: string; start: number; end: number }[];
  /** Everything else: 风格 / 场景 / 光线 / 机位 lines. */
  body: string[];
}

export function splitPromptLines(prompt: string): PromptLines {
  const out: PromptLines = { all: [], reference: [], require: [], dialogue: [], sound: [], main: [], beats: [], body: [] };
  for (const raw of prompt.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    out.all.push(line);
    if (REF_LINE.test(line)) out.reference.push(line);
    else if (REQUIRE_LINE.test(line)) out.require.push(line);
    else if (DIALOGUE_LINE.test(line)) out.dialogue.push(line);
    else if (SOUND_LINE.test(line)) out.sound.push(line);
    else if (MAIN_LINE.test(line)) out.main.push(line);
    else { const m = BEAT_LINE.exec(line); if (m) out.beats.push({ line, start: Number(m[1]), end: Number(m[2]) }); else out.body.push(line); }
  }
  return out;
}

/** First pieces of `lines` that match `re` (sentences, or clauses when a sentence is long). */
function hits(lines: readonly string[], re: RegExp, limit = 3) {
  const found: string[] = [];
  for (const line of lines) for (const sentence of sentences(line)) {
    if (!re.test(sentence)) continue;
    const piece = sentence.length > 80 ? clauses(sentence).find((clause) => re.test(clause)) ?? sentence.slice(0, 80) : sentence;
    if (!found.includes(piece)) found.push(piece);
    if (found.length >= limit) return found;
  }
  return found;
}

const SPEAKING = /说话|说那一?句|说出|说台词|speaks?|speaking/i;
const chars = (text: string) => text.replace(/[\s，。！？、,.!?…“”"「」：:；;]/g, "").length;

/**
 * Positions at the end / start of a shot: 「他在画左」「她看向他，脚留在画右」「看向画右的她」 → { 他: "画左", 她: "画右" }.
 * A clause that starts with 他 / 她 / a name sets who the following clauses of the sentence talk about.
 */
export function positionsIn(text: string, names: readonly string[]) {
  const who = ["他", "她", ...names.filter((name) => name.length >= 2)];
  const escaped = who.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const lead = new RegExp(`^(?:\\d+(?:\\.\\d+)?\\s*[-–~～至到]\\s*\\d+(?:\\.\\d+)?\\s*秒\\s*[：:]\\s*|最终状态\\s*[：:]?\\s*)?(${escaped})`);
  const owned = new RegExp(`(画左|画右|画中)的(${escaped})`, "g");
  const place = /画左|画右|画中|画面左侧|画面右侧/g;
  const out: Record<string, string> = {};
  const norm = (where: string) => where.replace("画面左侧", "画左").replace("画面右侧", "画右");
  for (const sentence of text.split(/[。；;\n]/)) {
    let current: string | null = null;
    for (const clause of sentence.split(/[，,]/).map((piece) => piece.trim())) {
      const own = lead.exec(clause)?.[1]; if (own) current = own;
      let rest = clause;
      for (const m of clause.matchAll(owned)) { out[m[2]] ??= m[1]; rest = rest.replace(m[0], ""); }
      const at = rest.match(place)?.[0];
      if (at && current) out[current] ??= norm(at);
    }
  }
  return out;
}

/**
 * Which hand holds what: 「右手拿着一支红笔」「左手攥着手机」 → { 红笔: "右手", 手机: "左手" }（量词去掉）.
 * Only hold verbs with an object, so 「右手食指点在稿纸上」 is not a hold.
 */
export function handsIn(text: string) {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(左手|右手)(?:里|上)?(?:还|仍|依旧)?(?:拿着|握着|捏着|攥着|端着|托着|举着|提着|抓着|夹着)(?:一|那|这)?(?:支|只|个|部|杯|本|张|把|台|根|份|块|瓶)?([一-鿿]{1,4})/g)) {
    const item = m[2].replace(/[的了着]$/, "");
    if (item) out[item] ??= m[1];
  }
  return out;
}

const shotEnd = (prompt: string) => { const lines = splitPromptLines(prompt); const last = lines.beats[lines.beats.length - 1]?.line ?? ""; const final = /最终状态[：:]?([^\n]*)/.exec(prompt)?.[1] ?? ""; return `${last}\n${final}`; };
const shotStart = (prompt: string) => { const lines = splitPromptLines(prompt); return `${lines.body.join("\n")}\n${lines.beats[0]?.line ?? ""}`; };

/** 官方 Ref2VA 六段式：中文写法的类别不判（不适用），画面五项用和 h3q official_five 同一套英文词判。 */
export const OFFICIAL_NA_NOTE = "官方格式不按中文写法查；写法对错看正本 h3q 的 [官方·…] 检查";
function officialCompleteness(shot: ShotQueueShot): CategoryResult[] {
  const text = officialFiveText(shot.prompt);
  const five = new Map(OFFICIAL_FIVE.map((item) => [item.id, item] as const));
  return PROMPT_CATEGORIES.map((category): CategoryResult => {
    const rule = five.get(category.id as never);
    if (!rule) return { id: category.id, state: "na", evidence: [], note: OFFICIAL_NA_NOTE };
    const m = rule.re.exec(text);
    if (!m) return { id: category.id, state: "missing", evidence: [], note: `官方格式没写${category.label}：${rule.how}` };
    const at = m.index ?? 0;
    const start = Math.max(text.lastIndexOf("\n", at) + 1, at - 60), end = Math.min(text.length, at + m[0].length + 60);
    return { id: category.id, state: "ok", evidence: [text.slice(start, end).trim()] };
  });
}

export function shotCompleteness(shot: ShotQueueShot, ctx: CompletenessContext): CategoryResult[] {
  if (isOfficialFormat(shot.prompt)) return officialCompleteness(shot);
  const lines = splitPromptLines(shot.prompt);
  const described = [...lines.body, ...lines.main, ...lines.beats.map((beat) => beat.line)];
  const visible = ctx.visibleNames;
  const silent = shot.soundMode === "silent";
  const row = parseDialogueRow(shot.prompt);
  const results: Partial<Record<CategoryId, CategoryResult>> = {};
  const set = (id: CategoryId, state: CompletenessState, evidence: string[] = [], note?: string) => { results[id] = { id, state, evidence, ...(note ? { note } : {}) }; };

  // 参考说明
  if (!shot.roleIds.length && !shot.sceneAssetIds.length && !lines.reference.length) set("reference", "na", [], "这一镜没有绑角色或场景图");
  else if (!lines.reference.length) set("reference", "missing", [], "没有「参考说明」这一行");
  else {
    const ref = lines.reference.join("\n");
    const lacking = visible.filter((name) => !new RegExp(`是${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^。；\\n]{0,60}只用于`).test(ref));
    // 场景图写「不用于人物」是正本模板的写法，不是硬要求：标准范本（EP02v5 L03，h3q 0/0/0、已实渲）写成「只用于确认房间布局」也算写了，只提示。
    const sceneHint = shot.sceneAssetIds.length && !/不用于人物/.test(ref) ? "提示：场景图可以照正本模板加一句「不用于人物」" : "";
    const note = lacking.length ? `没写「是${lacking.join("、是")}，…只用于」` : "";
    set("reference", note ? "missing" : "ok", sentences(ref).slice(0, 4), note || sceneHint || undefined);
  }

  // 风格胶片
  const film = hits(lines.body, FILM, 2);
  set("style", film.length ? "ok" : "missing", film.length ? film : lines.body.slice(0, 1), film.length ? undefined : "没写胶片或色彩（如 Kodak Vision3 250D 胶片颗粒）");

  // 场景
  const scene = hits(lines.body, SCENE, 2);
  set("scene", scene.length ? "ok" : "missing", scene, scene.length ? undefined : "没写地点和房间里的东西");

  // 道具可见
  const props = hits(described, PROP_ACTION, 2);
  if (!props.length) set("props", "na", [], "没看到手拿的道具");
  else { const visibleLine = hits(lines.all, VISIBLE, 1); set("props", visibleLine.length ? "ok" : "missing", visibleLine.length ? visibleLine : props, visibleLine.length ? undefined : "有道具，但没写「必须清晰可见」"); }

  // 光线
  const light = hits(lines.body, LIGHT, 2);
  const lightAnywhere = light.length ? light : hits(described, LIGHT, 2);
  set("light", lightAnywhere.length ? "ok" : "missing", lightAnywhere, lightAnywhere.length ? undefined : "没写光源、方向、亮在哪一侧");

  // 主要动作 / 分秒
  set("main", lines.main.length ? "ok" : "missing", lines.main.slice(0, 1), lines.main.length ? undefined : "没有「主要动作：」这一行");
  set("timeline", lines.beats.length ? "ok" : "missing", lines.beats.slice(0, 3).map((beat) => beat.line.slice(0, 60)), lines.beats.length ? undefined : "没有按秒分段（0-3秒：……）");

  // 景别焦段
  const sizeText = described.join("\n");
  const missingSize = [SIZE.test(sizeText) ? "" : "景别", LENS.test(sizeText) ? "" : "焦段", DOF.test(sizeText) ? "" : "景深"].filter(Boolean);
  set("shotsize", missingSize.length ? "missing" : "ok", hits(described, new RegExp(`${SIZE.source}|${LENS.source}|${DOF.source}`, "i"), 3), missingSize.length ? `缺${missingSize.join("、")}` : undefined);

  // 构图
  const compose = hits(described, COMPOSE, 2);
  set("compose", compose.length ? "ok" : "missing", compose, compose.length ? undefined : "没写主体在画面哪里、前后景是什么");

  // 站位朝向
  if (!visible.length) set("blocking", "na", [], "没有出镜角色");
  else {
    const missingBlock = [POSITION.test(sizeText) ? "" : "画左/画右", FACING.test(sizeText) ? "" : "朝向", visible.length >= 2 && !DISTANCE.test(sizeText) ? "两人距离" : ""].filter(Boolean);
    set("blocking", missingBlock.length ? "missing" : "ok", hits(described, new RegExp(`${POSITION.source}|${FACING.source}|${DISTANCE.source}`, "i"), 3), missingBlock.length ? `缺${missingBlock.join("、")}` : undefined);
  }

  // 运镜机位
  const camera = hits(described, CAMERA, 2);
  set("camera", camera.length ? "ok" : "missing", camera, camera.length ? undefined : "没写机位或运镜（固定 / 推 / 拉 / 跟……）");

  // 每段表情
  if (!visible.length) set("face", "na", [], "没有出镜角色");
  else if (!lines.beats.length) set("face", "missing", [], "没有分时间段，没法看每段表情");
  else {
    const subjects = ["他", "她", ...visible];
    const short = lines.beats.filter((beat) => {
      if (!PERF.test(beat.line)) return true;
      if (visible.length < 2 || TOGETHER.test(beat.line)) return false;
      return subjects.filter((who) => beat.line.includes(who)).length < 2;
    });
    const label = (beat: { start: number; end: number }) => `${beat.start}-${beat.end}秒`;
    set("face", short.length ? "missing" : "ok", (short.length ? short : lines.beats).slice(0, 3).map((beat) => beat.line.slice(0, 60)),
      short.length ? `${short.map(label).join("、")} ${visible.length >= 2 ? "没写到每个人的表情或小反应（按他 / 她粗判，可能误报）" : "没写表情或小反应"}` : undefined);
  }

  // 左右手
  const handClauses = described.flatMap(clauses).filter((clause) => HAND.test(clause.replace(/手指(?:收紧|蜷|攥|微颤|发抖)|手部|手指数量/g, "")));
  if (!handClauses.length) set("hands", "na", [], "没有手部动作");
  else { const bare = handClauses.filter((clause) => !SIDE.test(clause)); set("hands", bare.length ? "missing" : "ok", (bare.length ? bare : handClauses).slice(0, 3), bare.length ? "这几处没写左手还是右手" : undefined); }

  // 声音段 / 动作声
  if (silent) { set("sound", "na", [], "静音镜"); set("actionSound", "na", [], "静音镜"); }
  else {
    set("sound", lines.sound.length ? "ok" : "missing", lines.sound.slice(0, 1), lines.sound.length ? undefined : "没有「声音：」这一行");
    const action = hits(lines.sound, ACTION_SOUND, 2);
    const faint = action.length && /很轻|轻轻|细微|微弱/.test(lines.sound.join("")) ? "提示（正本 v2026-11-11.2）：重要动作声写成明显的声音，不写「很轻」" : undefined;
    set("actionSound", action.length ? "ok" : "missing", action.length ? action : lines.sound.slice(0, 1), action.length ? faint : "声音段没写动作的声音（纸页轻响、椅子轻吱……）");
  }

  // 对白语气 / 台词时长
  const fieldLines = (shot.dialogue ?? []).filter((line) => line.text?.trim());
  if (!row.entries.length && !fieldLines.length) { set("dialogue", "na", [], "没有台词"); set("dialogueTime", "na", [], "没有台词"); }
  else {
    const toneless = row.entries.filter((entry) => !entry.tone).map((entry) => entry.speaker);
    // 语气括号是正本模板的写法，不是硬要求（第一集写法第 4 条、标准范本都写「张三：“……”」），只提示；台词放进 dialogue 字段、没有对白行才算漏写。
    const note = [fieldLines.length ? `台词在 dialogue 字段里（正本要求留空，写进对白行）` : "", !lines.dialogue.length ? "没有「对白（中文普通话，口型同步）：」这一行" : ""].filter(Boolean).join("；");
    const toneHint = toneless.length ? `提示：${[...new Set(toneless)].join("、")} 可以加语气（如 张三（平淡）：“……”）` : undefined;
    set("dialogue", note ? "missing" : "ok", lines.dialogue.length ? lines.dialogue.slice(0, 1) : fieldLines.map((line) => line.text).slice(0, 2), note || toneHint);
    const texts = row.entries.length ? row.entries.map((entry) => entry.text) : fieldLines.map((line) => line.text);
    const speaking = lines.beats.filter((beat) => SPEAKING.test(beat.line));
    const actual = getActualDuration(shot.seconds).actualSeconds;
    const short: string[] = [];
    if (speaking.length === texts.length) speaking.forEach((beat, i) => { const need = chars(texts[i]) / 3.5; if (need > beat.end - beat.start + 0.05) short.push(`${beat.start}-${beat.end}秒说 ${chars(texts[i])} 字，约要 ${need.toFixed(1)} 秒`); });
    else { const total = texts.reduce((sum, text) => sum + chars(text), 0); if (total / 3.5 > actual + 0.05) short.push(`一共 ${total} 字，约要 ${(total / 3.5).toFixed(1)} 秒，整镜只有 ${actual.toFixed(1)} 秒`); }
    // 正本 v2026-11-11.2（标准队列实测，单次结果 / 🧪）：有台词镜开场没台词那段 ≤1 秒；时间段卡不住开口时间，最后一句后多留 1～2 秒。只提示，不算漏写。
    const timingHints: string[] = [];
    if (speaking.length) {
      const opening = speaking[0].start - (lines.beats[0]?.start ?? 0);
      if (opening > 1.05) timingHints.push(`开场 ${opening} 秒没台词（正本 v2026-11-11.2 建议 ≤1 秒，🧪）`);
      const tail = actual - speaking[speaking.length - 1].end;
      if (tail < 1.95) timingHints.push(`最后一句后只留 ${Math.max(0, tail).toFixed(1)} 秒（正本 v2026-11-11.2：实际开口会晚，多留 1～2 秒或后期剪）`);
    }
    const timeNote = short.length ? short.join("；") : [speaking.length !== texts.length ? "说话段和台词句数对不上，按整镜算" : "", ...timingHints].filter(Boolean).join("；");
    set("dialogueTime", short.length ? "missing" : "ok", speaking.slice(0, 2).map((beat) => beat.line.slice(0, 60)), timeNote || undefined);
  }

  // 画面要求
  if (!lines.require.length) set("require", "missing", [], "没有「画面要求：」这一行");
  else if (ctx.episodeRequire && lines.require[0] !== ctx.episodeRequire) set("require", "missing", lines.require.slice(0, 1), "和整集多数镜头的「画面要求」写法不同（正本要求整集逐字复用）");
  else set("require", "ok", lines.require.slice(0, 1));

  // 镜间衔接
  const previous = ctx.previous;
  const sameScene = previous && previous.sceneAssetIds[0] && previous.sceneAssetIds[0] === shot.sceneAssetIds[0];
  if (shot.firstFrameFrom) set("continuity", "ok", [], "首帧接上一镜的帧");
  else if (!previous) set("continuity", "na", [], "队列第一镜");
  else if (!sameScene) set("continuity", "na", [], "和上一镜不是同一张场景图");
  else if (!visible.length) set("continuity", "na", [], "没有出镜角色");
  else {
    const names = ctx.roleNames ?? visible;
    const before = positionsIn(shotEnd(previous.prompt), names), after = positionsIn(shotStart(shot.prompt), names);
    const clash = Object.keys(after).filter((who) => before[who] && before[who] !== after[who]);
    // 手和道具：上一镜结束哪只手拿着什么，这一镜开始同一样东西不能换手（正本细节清单第 5、8 条）。
    const heldBefore = handsIn(shotEnd(previous.prompt)), heldAfter = handsIn(shotStart(shot.prompt));
    const swapped = Object.keys(heldAfter).filter((item) => heldBefore[item] && heldBefore[item] !== heldAfter[item]);
    if (!Object.keys(before).length) set("continuity", "missing", [], "上一镜结尾（最后一段 / 最终状态）没写谁在画左画右，接不上");
    else if (!Object.keys(after).length) set("continuity", "missing", [], "这一镜开始没写谁在画左画右");
    else if (clash.length || swapped.length) set("continuity", "missing", hits([shotStart(shot.prompt)], clash.length ? POSITION : SIDE, 2), [...clash.map((who) => `上一镜结束${who}在${before[who]}，这一镜开始在${after[who]}`), ...swapped.map((item) => `上一镜结束${item}在${heldBefore[item]}，这一镜开始换到了${heldAfter[item]}`)].join("；"));
    else set("continuity", "ok", hits([shotStart(shot.prompt)], POSITION, 2), `上一镜结束：${Object.entries(before).map(([who, where]) => `${who}${where}`).join("、")}`);
  }

  return PROMPT_CATEGORIES.map((category) => results[category.id]!);
}

/** 整集：每一镜的结果，和多数镜头用的「画面要求」。 */
export function queueCompleteness(queue: ShotQueue, namesOf: (shot: ShotQueueShot) => { visible: string[]; all: string[] }) {
  const flat = queue.chapters.flatMap((chapter, c) => chapter.shots.map((shot, s) => ({ shot, chapter: c, index: s })));
  const counts = new Map<string, number>();
  for (const { shot } of flat) { const line = splitPromptLines(shot.prompt).require[0]; if (line) counts.set(line, (counts.get(line) ?? 0) + 1); }
  const majority = flat.length >= 2 ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null : null;
  return flat.map(({ shot, chapter, index }, i) => {
    const names = namesOf(shot);
    return { key: `${chapter}:${index}`, title: shot.title, results: shotCompleteness(shot, { visibleNames: names.visible, roleNames: names.all, previous: i ? flat[i - 1].shot : null, episodeRequire: majority }) };
  });
}
