import assert from "node:assert/strict";
import { compileH3Prompt, suppressBackgroundMusic, markAudibleSegments, AUDIBLE_SEGMENT_LINES as L, H3_PROMPT_SOFT_LIMIT } from "../lib/comfyui/h3-prompt.ts";
import { prepareH3ReferenceSubmission } from "../lib/h3-reference-submission.ts";

// 正本「第一集写法」：台词只在对白行，动作段用他 / 她、写「说话」，不写「开口」。
const ZH = [
  "写实真人电影质感。他在她身前，沙发在画右。",
  "0-2秒：他转身，坐到画右沙发上。她的左手从他肩上放开",
  "2-5秒：她看向他，说话。",
  "他坐在画右沙发。",
  "声音：只有很轻的房间底噪。",
  "对白（中文普通话，口型同步）：李四：“你别走。”",
].join("\n");
const EN = "Medium close-up, camera locked. Already in motion at 00:00: Subject 1 is frame left. 00:00-03:00 Subject 1 looks up, lips closed. 03:00-08:00 Subject 1 speaks, lips moving. 08:00-09:00 He stays still. After the last word, the shot ends. One continuous take, no cuts.";
const BRACKET = "A man sits at his desk. [0s-3s] He slowly lowers the document. [3s-6s] He says <d>[Chinese] 进来。</d>\nSound: quiet office room tone.";

// Box not ticked, av: prompt unchanged.
for (const p of [ZH, EN, BRACKET]) assert.equal(compileH3Prompt(p, "av", false), p.trim());

// 禁背景乐: every segment says what is heard; speaking segments include their line.
{
  const out = compileH3Prompt(ZH, "av", true);
  assert.ok(out.includes(`0-2秒：他转身，坐到画右沙发上。她的左手从他肩上放开。${L.zh}\n`), out);
  assert.ok(out.includes(`2-5秒：她看向他，说话。${L.zhLine}\n`), out);
  assert.ok(out.includes("\n他坐在画右沙发。\n"), "unlabelled final-state line untouched");
  assert.ok(out.includes("\n对白（中文普通话，口型同步）：李四：“你别走。”\n"), "对白 row untouched");
  assert.equal(out.split("这段听到的").length - 1, 2);
  // 这段听到的：没有人名、没有「开口」、没有元指令。
  for (const sentence of out.match(/这段听到的：[^。]*。/g)) assert.doesNotMatch(sentence, /李四|张三|开口|台词|numbered|line \d/);
}
// 没有对白行：哪段写了说话 / 开口都只写底噪和动作声（判断有没有话看对白行，不看「开口」）。
{
  const noRow = ZH.replace(/\n对白[^\n]*/, "").replace("说话。", "开口说：“你别走。”");
  const out = compileH3Prompt(noRow, "av", true);
  assert.ok(!out.includes(L.zhLine) && !out.includes(L.zhAny), out);
}
// 有对白行，但没有哪段写说话：每段统一写「房间底噪、对白和动作的声响」。
{
  const out = compileH3Prompt(ZH.replace("她看向他，说话。", "她看向他，眨一下眼。"), "av", true);
  assert.equal(out.split(L.zhAny).length - 1, 2, out);
  assert.ok(!out.includes(L.zhLine));
}
{
  const out = compileH3Prompt(EN, "av", true);
  assert.ok(out.includes(`00:00-03:00 Subject 1 looks up, lips closed. ${L.en} 03:00-08:00`), out);
  assert.ok(out.includes(`03:00-08:00 Subject 1 speaks, lips moving. ${L.en} 08:00-09:00`), "no 对白 row / <d>: no line sentence");
  assert.ok(compileH3Prompt(`${EN} <d>[Chinese] 进来。</d>`, "av", true).includes(`03:00-08:00 Subject 1 speaks, lips moving. ${L.enLine} 08:00-09:00`));
  assert.ok(out.includes(`08:00-09:00 He stays still. ${L.en} After the last word`), out);
  assert.ok(!/Already in motion at 00:00: Subject 1 is frame left\. Heard/.test(out), "start state is not a segment");
}
{
  const out = compileH3Prompt(BRACKET, "av", true);
  assert.ok(out.includes(`[0s-3s] He slowly lowers the document. ${L.en} [3s-6s]`), out);
  assert.ok(out.includes(`[3s-6s] He says <d>[Chinese] 进来。</d> ${L.enLine}\nSound:`), out);
}

// 只要环境声: segments get the sentence without lines, even when they speak; without the BGM box too.
for (const noBgm of [false, true]) {
  const out = compileH3Prompt(ZH, "ambient", noBgm);
  assert.ok(out.includes(`说话。${L.zh}\n`), out);
  assert.ok(!out.includes(L.zhLine));
  assert.match(out, /声音要求：可听到的只有与画面同步的房间底噪和动作声。$/);
}

// Positive wording only: no music / voice negations sneak in.
for (const out of [compileH3Prompt(ZH, "av", true), compileH3Prompt(EN, "ambient", true)]) {
  assert.doesNotMatch(out, /music|BGM|soundtrack|score|singing|narrat|voice-?over|音乐|配乐|歌|旁白|人声/i, out);
}

// Idempotent, also through the reference submission path (suppress first, compile second).
assert.equal(suppressBackgroundMusic(suppressBackgroundMusic(ZH)), suppressBackgroundMusic(ZH));
assert.equal(markAudibleSegments(markAudibleSegments(EN, true), true), markAudibleSegments(EN, true));
assert.equal(compileH3Prompt(suppressBackgroundMusic(ZH, "ambient"), "ambient").split("这段听到的").length - 1, 2);

// No segments: only the closing marker, as before.
assert.equal(compileH3Prompt("Landscape", "av", true), "Landscape\n\nAudible audio is room tone and the action sounds already described.");

// Length guard: a prompt near the queue cap keeps its text and skips the per-segment lines.
{
  const long = `${"x".repeat(H3_PROMPT_SOFT_LIMIT - 40)}\n0-2秒：他转身。\n2-4秒：她坐下。`;
  assert.ok(long.length <= H3_PROMPT_SOFT_LIMIT);
  assert.equal(markAudibleSegments(long, true), long);
}

// Reference submission keeps the ambient choice when it suppresses first.
{
  const prepared = prepareH3ReferenceSubmission({ images: [], videos: [], audios: [], roles: [], soundMode: "ambient", dialogue: [], allowEmptyForTextGeneration: true }, { prompt: ZH, promptMode: "plain", community: true, noBackgroundMusic: true });
  assert.ok(prepared.compiled.prompt.includes(L.zh));
  assert.ok(!prepared.compiled.prompt.includes(L.zhLine), prepared.compiled.prompt);
}

// ── 2026-11-12「说完」漏洞：和正本 h3q GAP_SPEAK / GAP_NOT 同一套词 ──
{
  const { segmentSpeaks } = await import("../lib/comfyui/h3-prompt.ts");
  for (const text of ["她把下一句说完", "他接着说", "她回答", "他喊她的名字", "她念出那一行", "他问一句", "她答道", "he asks her", "she answers", "he says it"]) assert.ok(segmentSpeaks(text), text);
  for (const text of ["她没说完就停住", "他不说话", "她已经说完，看着他", "他听她说完，点头", "她别过脸，不再开口", "他看向窗外"]) assert.ok(!segmentSpeaks(text), text);
  const prompt = ["写实真人电影质感。", "0-3秒：她抬眼看他，把下一句说完。", "3-6秒：他没说话，低头翻稿纸。", "对白（中文普通话，口型同步）：李四：“我还没看完。”"].join("\n");
  const out = markAudibleSegments(prompt, true);
  assert.match(out, /把下一句说完。这段听到的：房间底噪、这段的对白和动作的声响。/, "「说完」那段算说话");
  assert.match(out, /低头翻稿纸。这段听到的：房间底噪和这段动作的声响。/, "「没说话」那段照旧只有底噪和动作声");
  assert.ok(!out.includes(L.zhAny), "找到了说话段，不再给每段都加泛泛的「对白」");
  // 没有台词：不管写没写说完，都只加底噪和动作声（禁背景乐的追加句只在确实有人说话时变）
  assert.ok(!markAudibleSegments(prompt.split("\n").slice(0, 3).join("\n"), true).includes(L.zhLine));
}

console.log("PASS per-segment heard-sound lines: zh / clock / bracket, lines only when speaking, ambient, positive wording, idempotent, length guard");
