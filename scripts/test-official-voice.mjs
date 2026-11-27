// 🧪 官方格式送角色声音（2026-11-13；内部对比实验：O1 + 两条声音，5 个种子都不乱说话）。
// 默认不送；写了 voiceRoleIds 才按顺序送（= <Audio 1>…，提交时截前 8 秒），正文一字不改。人数和正文 <Audio N> 对不上就拦。
// V1 正文见 scripts/fixtures/official-format/V1_voice_queue.json。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileQueueShotPictures } from "../lib/queue-picture-order.ts";
import { shotCardChecks } from "../lib/shot-card-report.ts";
import { queueGate, shotGate, shotGateMessage } from "../lib/shot-gate.ts";
import { resolveH3Speaker } from "../lib/h3-speaker-policy.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";
import { officialVoiceProblem, OFFICIAL_VOICE_ID } from "../lib/official-format.ts";
import { hardRuleById } from "../lib/hard-rules.ts";
import { VOICE_SAMPLE_SECONDS } from "../lib/voice-roles.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/official-format/${name}`, import.meta.url), "utf8"));
const ROLE_C = "00000000-0000-4000-8000-00000000000e", ROLE_A = "00000000-0000-4000-8000-00000000000a", ROLE_B = "00000000-0000-4000-8000-00000000000b";
const NAMES = { [ROLE_C]: "王五", [ROLE_A]: "张三", [ROLE_B]: "李四" };
function world(queue, { noVoice = [], seconds = {} } = {}) {
  const shots = queue.chapters.flatMap((c) => c.shots);
  const roleIds = [...new Set(shots.flatMap((s) => s.roleIds))], sceneIds = [...new Set(shots.flatMap((s) => s.sceneAssetIds))];
  const roles = roleIds.map((roleId) => ({ roleId, displayName: NAMES[roleId], description: "", appearanceAssetIds: [`${roleId}-look`], voiceAssetIds: noVoice.includes(roleId) ? [] : [`${roleId}-voice`], primaryAppearanceAssetId: `${roleId}-look`, primaryVoiceAssetId: noVoice.includes(roleId) ? null : `${roleId}-voice` }));
  const assets = new Map([...sceneIds.map((id) => [id, { assetId: id, kind: "image", storageReference: `image:${id}`, filename: `${id}.png` }]), ...roleIds.flatMap((id) => [[`${id}-look`, { assetId: `${id}-look`, kind: "image", storageReference: `image:${id}-look`, filename: `${NAMES[id]}.png` }], ...(noVoice.includes(id) ? [] : [[`${id}-voice`, { assetId: `${id}-voice`, kind: "audio", storageReference: `audio:${id}-voice`, filename: `${NAMES[id]}.wav`, ...(seconds[id] ? { duration: seconds[id] } : {}) }]])])]);
  return { roles, assets };
}
const submit = (shot, w, noBackgroundMusic = false) => compileQueueShotPictures({ shot, scenes: shot.sceneAssetIds.map((id) => ({ assetId: id, src: `image:${id}`, name: `${id}.png` })), roles: w.roles.filter((r) => shot.roleIds.includes(r.roleId)), assets: w.assets, roleAssets: Object.fromEntries([...w.assets.values()].map((a) => [a.assetId, a])), includeRoleVoices: true, noBackgroundMusic }).prepared;

const V1 = fixture("V1_voice_queue.json"), O1O2 = fixture("O1O2_queue.json");
const v1 = V1.chapters[0].shots[0], o1 = O1O2.chapters[0].shots[0];

// ── 1. 写了 voiceRoleIds：载入不报错，提交接两条声音（顺序 = voiceRoleIds = <Audio 1>、<Audio 2>），正文逐字一致 ──
assert.doesNotThrow(() => parseShotQueue(JSON.stringify(V1)), "官方格式写 voiceRoleIds 不要求「参考说明」行");
const w = world(V1);
for (const nbm of [false, true]) {
  const prepared = submit(v1, w, nbm);
  assert.equal(prepared.compiled.prompt, v1.prompt, `nbm=${nbm}：提交正文和原文逐字一致`);
  assert.deepEqual(prepared.manifest.audioRefs.map((ref) => [ref.label, ref.filename]), [["<Audio 1>", "王五.wav"], ["<Audio 2>", "张三.wav"]], "两条声音，顺序照 voiceRoleIds");
  assert.deepEqual(prepared.payload.audios.map((a) => a.filename), ["王五.wav", "张三.wav"], "提交顺序 ref_audio_0 = 王五、ref_audio_1 = 张三");
  assert.deepEqual(prepared.manifest.voiceRoleIds, [ROLE_C, ROLE_A], "manifest 记下 voiceRoleIds（提交时据此截前 8 秒）");
  assert.ok(prepared.compiled.notes.some((n) => n.includes("送了 2 条角色声音")), JSON.stringify(prepared.compiled.notes));
}
// 截前 8 秒：节点提交时 manifest 有 voiceRoleIds 就加 referenceAudioTrimSeconds（沿用旧格式声音路的 TrimAudioDuration）。
assert.equal(VOICE_SAMPLE_SECONDS, 8);
assert.match(readFileSync(new URL("../app/canvas-workspace.tsx", import.meta.url), "utf8"), /manifest\.voiceRoleIds\?\.length \? \{ \.\.\.settings, referenceAudioTrimSeconds: VOICE_SAMPLE_SECONDS \}/);
// 节点自己点生成：说话角色策略照样交出 voiceRoleIds，不自动选角色。
{ const policy = resolveH3Speaker({ prompt: v1.prompt, roleIds: v1.roleIds, voiceRoleIds: v1.voiceRoleIds, dialogue: [], autoVoiceEnabled: true, soundMode: "av" });
  assert.deepEqual([policy.official, policy.disabled, policy.voiceRoleId, policy.voiceRoleIds, policy.errors], [true, false, undefined, [ROLE_C, ROLE_A], []]); }
// 卡片：0 拦、0 红。
assert.deepEqual(shotGate(v1), [], "画布判定不拦");
assert.deepEqual(shotGate(v1, [], []), [], "h3q 判定（没报）也不拦");
assert.deepEqual(shotCardChecks(v1, V1, w.roles, w.assets).filter((c) => c.level === "error"), []);

// ── 2. 不写 voiceRoleIds 的官方格式镜头：照旧不送声音 ──
{ const prepared = submit(o1, world(O1O2));
  assert.deepEqual(prepared.manifest.audioRefs, []); assert.equal(prepared.compiled.prompt, o1.prompt);
  const policy = resolveH3Speaker({ prompt: o1.prompt, roleIds: o1.roleIds, dialogue: [], autoVoiceEnabled: true, soundMode: "av" });
  assert.deepEqual([policy.disabled, policy.voiceRoleId, policy.voiceRoleIds], [true, undefined, undefined]);
  assert.deepEqual(shotGate(o1), []); }

// ── 3. 对不上就拦，说人话、写改法 ──
const cases = [
  [{ ...v1, voiceRoleIds: [ROLE_C] }, /voiceRoleIds 写了 1 个人，正文里写的是 <Audio 1>、<Audio 2>/],
  [{ ...v1, voiceRoleIds: undefined }, /正文写了 <Audio 1>、<Audio 2>，但这一镜没写 voiceRoleIds/],
  [{ ...o1, voiceRoleIds: [ROLE_C, ROLE_A] }, /voiceRoleIds 写了 2 个人，正文里一个 <Audio N> 都没写/],
  [{ ...v1, prompt: v1.prompt.replaceAll("<Audio 2>", "<Audio 3>") }, /正文里写的是 <Audio 1>、<Audio 3>/],
];
for (const [shot, re] of cases) {
  const items = shotGate(shot);
  assert.deepEqual(items.map((i) => i.id), [OFFICIAL_VOICE_ID], JSON.stringify(items));
  assert.match(items[0].note, re); assert.match(items[0].note, /改法/);
  assert.deepEqual(shotGate(shot, [], []).map((i) => i.id), [OFFICIAL_VOICE_ID], "h3q 判定时画布也补上这一条（h3q 还没这条检查）");
  assert.match(shotGateMessage(shot, [], undefined, []), /^官方·角色声音不过，不能渲染/);
}
// h3q 以后报了同一条：用 h3q 那条，不重复。
{ const rule = hardRuleById(OFFICIAL_VOICE_ID); assert.ok(rule && rule.canvasFallback && rule.fixes);
  const items = shotGate(cases[0][0], [], [{ level: "ERROR", where: "", message: `${rule.prefix} 正本的说法` }]);
  assert.deepEqual(items.map((i) => [i.id, i.source]), [[OFFICIAL_VOICE_ID, "h3q"]]); }
// 整批入队也拦。
assert.equal(queueGate(parseShotQueue(JSON.stringify({ ...V1, chapters: [{ ...V1.chapters[0], shots: [{ ...v1, voiceRoleIds: [ROLE_C] }] }] }))).ok, false);
// 旧格式不管（旧格式的 voiceRoleIds 有自己的规则）。
assert.equal(officialVoiceProblem("参考说明：<Picture 1>是办公室。<Audio 1>是张三的声音", [ROLE_A, ROLE_C]), null);

// ── 4. 每人要有主声音（没有提交会失败）；样本超过 15 秒提醒 ──
{ const ww = world(V1, { noVoice: [ROLE_A] });
  const checks = shotCardChecks(v1, V1, ww.roles, ww.assets);
  assert.ok(checks.some((c) => c.level === "error" && c.code === "voice_role_no_voice" && c.message.includes("张三")), JSON.stringify(checks));
  assert.throws(() => submit(v1, ww), /主声音|声音/, "提交时也过不去"); }
{ const ww = world(V1, { seconds: { [ROLE_C]: 41 } });
  const checks = shotCardChecks(v1, V1, ww.roles, ww.assets);
  assert.ok(checks.some((c) => c.level === "warn" && c.code === "voice_sample_long" && c.message.includes("王五")), JSON.stringify(checks)); }

console.log("official voice: 写了 voiceRoleIds 送两条声音（顺序 = <Audio N>、截前 8 秒、正文逐字一致），不写不送，人数 / 编号对不上拦、没主声音红、样本太长提醒; ok");
