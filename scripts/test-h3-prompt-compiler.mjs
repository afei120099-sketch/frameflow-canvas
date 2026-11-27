import assert from "node:assert/strict";
import { buildReferenceManifest } from "../lib/reference-manifest.ts";
import { compileH3Prompt } from "../lib/comfyui/h3-prompt.ts";
import { compileH3Fl2vaPrompt, compileH3Ref2vaPrompt, dialogueLanguage, ENGLISH_NOTE, OFFICIAL_MODE_WARNING } from "../lib/h3-prompt-compiler.ts";

const asset = (assetId, kind, filename) => ({ assetId, kind, storageReference: `${kind}:${assetId}`, filename });
const roleAssets = { shibaFront: asset("shibaFront", "image", "柴犬正面.png"), catFront: asset("catFront", "image", "橘猫正面.png"), shibaVoice: asset("shibaVoice", "audio", "柴犬.wav"), catVoice: asset("catVoice", "audio", "橘猫.wav") };
const shiba = { roleId: "shiba", displayName: "柴犬", description: "a fluffy Shiba Inu with a red collar", appearanceAssetIds: ["shibaFront"], voiceAssetIds: ["shibaVoice"], primaryAppearanceAssetId: "shibaFront", primaryVoiceAssetId: "shibaVoice" };
const cat = { roleId: "cat", displayName: "橘猫", description: "", appearanceAssetIds: ["catFront"], voiceAssetIds: ["catVoice"], primaryAppearanceAssetId: "catFront", primaryVoiceAssetId: "catVoice" };
const LINE = "你是不是一直把装修公司的报价，当成装修总预算了？";
const RAW = "柴犬看着橘猫说话，橘猫本镜头不说话。";
const manifestFor = (overrides = {}) => buildReferenceManifest({ images: [], videos: [], audios: [], roles: [shiba, cat], roleAssets, dialogue: [{ roleId: "shiba", text: LINE }], soundMode: "av", ...overrides });

// No-dialogue plain tasks and FL2VA keep the verified behaviour byte-for-byte.
for (const soundMode of ["av", "ambient", "silent"]) {
  const manifest = manifestFor({ soundMode, dialogue: [] });
  assert.equal(compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode, mode: "plain", manifest }).prompt, compileH3Prompt(RAW, soundMode));
  assert.equal(compileH3Fl2vaPrompt({ rawPrompt: RAW, soundMode }).prompt, compileH3Prompt(RAW, soundMode));
}
assert.equal(compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "plain", manifest: manifestFor() }).mode, "plain");

// Regression: Chinese dialogue is really submitted, ordered and bound to actual payload labels.
{
  const manifest = manifestFor({
    images: [{ assetId: "previous", storageReference: "image:previous", filename: "尾帧.jpg", source: "first_frame" }],
    audios: [{ assetId: "catVoice", storageReference: "audio:catVoice", filename: "橘猫.wav" }],
    dialogue: [{ roleId: "shiba", text: "我说预算有限！" }, { roleId: "cat", text: "这个墙……挺好看。" }, { roleId: "shiba", text: "你先别说话。" }],
  });
  const frozen = JSON.stringify(manifest);
  const compiled = compileH3Ref2vaPrompt({ rawPrompt: "Keep the camera stable.", soundMode: "av", mode: "plain", manifest });
  assert.ok(compiled.prompt.startsWith("Keep the camera stable.\n\n"));
  assert.match(compiled.prompt, /<Subject 1> is 柴犬 in <Picture 2>/);
  assert.match(compiled.prompt, /<Subject 2> is 橘猫 in <Picture 3>/);
  assert.match(compiled.prompt, /1\. <Subject 1> \(柴犬, S1\) says in Mandarin Chinese, using <Audio 2>[^\n]*我说预算有限！/);
  assert.match(compiled.prompt, /2\. <Subject 2> \(橘猫, S2\) says in Mandarin Chinese, using <Audio 1>[^\n]*这个墙……挺好看。/);
  assert.match(compiled.prompt, /3\. <Subject 1> \(柴犬, S1\)[^\n]*你先别说话。/);
  assert.equal(JSON.stringify(manifest), frozen, "immutable Run manifest is unchanged");
  assert.ok(compiled.notes.length);
  assert.equal(compileH3Ref2vaPrompt({ rawPrompt: "Keep the camera stable.", soundMode: "av", mode: "plain", manifest }).prompt, compiled.prompt);
  assert.throws(() => compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "ambient", mode: "plain", manifest }), /视听生成/);
  const single = compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "plain", manifest: manifestFor() });
  // 旧队列 dialogue 非空：不再给没台词的角色加嘴唇句，也不加「These numbered lines…」元指令（正本 v2026-11-09.6）。
  assert.doesNotMatch(single.prompt, /lips closed|keeps the lips|complete speech|numbered lines|does not speak|do not translate|add dialogue/);
  assert.ok(single.notes.some((note) => note.includes("dialogue 字段不是空的")), "提示用一键按钮搬进正文");
  assert.doesNotMatch(single.prompt, /\(橘猫, S2\)/);
  assert.ok(single.prompt.includes(LINE));
}

// Official structure: the real scenario. 橘猫 is Subject 2 with no Speaker ID and no Audio.
{
  const manifest = manifestFor();
  const compiled = compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "official_structured", manifest });
  const expected = [
    "subject_definitions:",
    "<Subject 1> is 柴犬 in <Picture 1>, a fluffy Shiba Inu with a red collar.",
    "<Subject 2> is 橘猫 in <Picture 2>.",
    "<Audio 1> is the voice-timbre reference for <Subject 1> (S1).",
    "",
    "summary:",
    "[reference generation + audio reference] The target video features <Subject 1> and <Subject 2>. <Audio 1> is used as the voice-timbre reference for <Subject 1>.",
    "",
    "retention_analysis:",
    "<Subject 1> (appears in [Shot 1]): fully_preserved - the appearance of <Subject 1> from <Picture 1> is retained.",
    "<Subject 2> (appears in [Shot 1]): fully_preserved - the appearance of <Subject 2> from <Picture 2> is retained.",
    "<Audio 1>: reference - the dialogue of <Subject 1> follows the voice timbre of <Audio 1> without copying the original signal.",
    "",
    "detailed_description:",
    `[Shot 1] ${RAW}`,
    `<Subject 1> (S1) says, in the voice timbre referenced from <Audio 1>, <d>[Chinese] ${LINE}</d>`,
    "",
    "overall_soundscape:",
    "Natural ambient sounds and action sounds synchronized with the visuals.",
    "",
    "non_diegetic_music:",
    "N/A",
  ].join("\n");
  assert.equal(compiled.prompt, expected);
  assert.equal(compiled.mode, "official_structured");
  assert.deepEqual(compiled.notes, [OFFICIAL_MODE_WARNING, ENGLISH_NOTE]);
  // Six sections, official order.
  assert.deepEqual([...compiled.prompt.matchAll(/^([a-z_]+):$/gm)].map((match) => match[1]), ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]);
  assert.doesNotMatch(compiled.prompt, /\(S2\)/, "a silent Role receives no speaker ID");
  assert.doesNotMatch(compiled.prompt, /\(S\d\)[^\n]*retention|retention_analysis:\n[^]*\(S\d\)[^]*detailed_description/, "no (Sx) inside retention_analysis");
  // Deterministic.
  assert.equal(compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "official_structured", manifest }).prompt, compiled.prompt);
}

// 橘猫 answers later: S1 = 柴犬 (speaks first), S2 = 橘猫. Audio numbers stay in payload order (橘猫's explicit voice = Audio 1).
{
  const manifest = manifestFor({ audios: [{ assetId: "catVoice", storageReference: "audio:catVoice", filename: "橘猫.wav" }], dialogue: [{ roleId: "shiba", text: LINE }, { roleId: "cat", text: "我没有！" }, { roleId: "shiba", text: "Really?" }] });
  const { prompt } = compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "official_structured", manifest });
  assert.match(prompt, /^<Audio 1> is the voice-timbre reference for <Subject 2> \(S2\)\.$/m);
  assert.match(prompt, /^<Audio 2> is the voice-timbre reference for <Subject 1> \(S1\)\.$/m);
  const dialogue = prompt.split("detailed_description:\n")[1].split("\n\n")[0].split("\n").slice(1);
  assert.deepEqual(dialogue, [
    `<Subject 1> (S1) says, in the voice timbre referenced from <Audio 2>, <d>[Chinese] ${LINE}</d>`,
    "<Subject 2> (S2) says, in the voice timbre referenced from <Audio 1>, <d>[Chinese] 我没有！</d>",
    "<Subject 1> (S1) says, in the voice timbre referenced from <Audio 2>, <d>[English] Really?</d>",
  ]);
}

// Sound modes in official structure.
{
  const silent = compileH3Ref2vaPrompt({ rawPrompt: "A quiet room.", soundMode: "silent", mode: "official_structured", manifest: manifestFor({ soundMode: "silent", dialogue: [] }) });
  assert.match(silent.prompt, /overall_soundscape:\nN\/A\n\nnon_diegetic_music:\nN\/A$/);
  assert.doesNotMatch(silent.prompt, /<Audio/);
  assert.match(silent.prompt, /^\[reference generation\] /m);
  assert.deepEqual(silent.notes, [OFFICIAL_MODE_WARNING], "English description: no English-ization note");
  const ambient = compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "ambient", mode: "official_structured", manifest: manifestFor({ soundMode: "ambient", dialogue: [] }) });
  assert.match(ambient.prompt, /Only room tone and action sounds synchronized with the visuals are audible/);
}

// Official mode refuses references it cannot label without guessing.
{
  const withUnboundPicture = manifestFor({ images: [{ assetId: "room", storageReference: "image:room", filename: "客厅.png", source: "reference_image" }] });
  assert.throws(() => compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "official_structured", manifest: withUnboundPicture }), /参考图 <Picture 1>“客厅.png” 未绑定角色/);
  assert.doesNotThrow(() => compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "plain", manifest: withUnboundPicture }));
  const withVideo = manifestFor({ videos: [{ assetId: "clip", storageReference: "media:clip", filename: "客厅.mp4", withAudio: true }] });
  assert.throws(() => compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "official_structured", manifest: withVideo }), /暂不支持参考视频/);
  const silentCatVoice = manifestFor({ audios: [{ assetId: "catVoice", storageReference: "audio:catVoice", filename: "橘猫.wav" }] });
  assert.throws(() => compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "official_structured", manifest: silentCatVoice }), /<Audio 1>“橘猫.wav” 没有对应的说话角色/);
  const noRoles = buildReferenceManifest({ images: [{ assetId: "room", storageReference: "image:room", filename: "客厅.png", source: "reference_image" }], videos: [], audios: [], roles: [], roleAssets: {}, dialogue: [], soundMode: "av" });
  assert.throws(() => compileH3Ref2vaPrompt({ rawPrompt: RAW, soundMode: "av", mode: "official_structured", manifest: noRoles }), /至少需要加入一个角色/);
}

assert.equal(dialogueLanguage(LINE), "Chinese");
assert.equal(dialogueLanguage("Hey! Watch your dog!"), "English");
assert.throws(() => dialogueLanguage("こんにちは"), /只支持中文或英文/);
assert.throws(() => dialogueLanguage("……"), /无法确定台词语言/);

console.log("H3 Prompt Compiler plain/official modes, speakers, audio labels, sound modes and refusals passed");
