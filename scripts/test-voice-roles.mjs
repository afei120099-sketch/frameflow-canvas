// 🧪 voiceRoleIds（plain 声音路）：同一份队列有没有 voiceRoleIds，正文只差参考说明末尾那一句；
// 提交时每个说话人的主声音按顺序接到 MiniMaxH3ReferenceToVideo 的 ref_audios 上，先经 TrimAudioDuration 截短。
// 夹具：中性示例队列及预期编译正文。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseShotQueue, shotQueueH3Props } from '../lib/shot-queue.ts';
import { compileQueueShotPictures } from '../lib/queue-picture-order.ts';
import { prepareH3ReferenceSubmission } from '../lib/h3-reference-submission.ts';
import { buildReferenceManifest } from '../lib/reference-manifest.ts';
import { planH3Submission } from '../lib/comfyui/h3-adapter.ts';
import { resolveH3Speaker } from '../lib/h3-speaker-policy.ts';
import { appendVoiceReference, voiceReferenceSentence, VOICE_SAMPLE_SECONDS, VOICE_SAMPLE_WARN_SECONDS } from '../lib/voice-roles.ts';
import { shotCardChecks } from '../lib/shot-card-report.ts';
import { missingPrimaryVoice } from '../lib/queue-voice-validation.ts';
import { freezeH3Roles } from '../lib/h3-role-snapshot.ts';

const fixture = (name) => readFileSync(new URL(`./fixtures/voice-roles/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shot = JSON.parse(fixture('sample-shot.json'));
const samplePrompt = fixture('sample-final-prompt.txt');
const [ROLE_A, ROLE_B, ROLE_C] = shot.roleIds; // 张三、李四、王五（Picture 3、4、5）
const [SCENE_A, SCENE_B] = shot.sceneAssetIds;

const queueOf = (patch = {}) => ({ version: 'shot-queue-v1', title: '角色声音验证', defaults: { workflow: 'ultimate', generationMode: 'auto', megapixels: 0.45, seed: 2740032055, noBackgroundMusic: true }, chapters: [{ title: '3-A 小组会议室', shots: [{ ...shot, ...patch }] }] });
const parse = (patch) => parseShotQueue(JSON.stringify(queueOf(patch)));

const plain = parse({}).chapters[0].shots[0];
const voiced = parse({ voiceRoleIds: [ROLE_C, ROLE_A] }).chapters[0].shots[0];
assert.equal(plain.voiceRoleIds, undefined, '旧队列不多出字段');
assert.deepEqual(voiced.voiceRoleIds, [ROLE_C, ROLE_A]);
assert.equal(voiced.voiceRoleId, undefined, '有「对白（」行也不自动带 roleIds[0] 的声音');
assert.equal(plain.voiceRoleId, undefined, '没写 voiceRoleIds 的第一集写法照旧一条声音都不送');
assert.deepEqual(parseShotQueue(JSON.stringify(parse({ voiceRoleIds: [ROLE_C, ROLE_A] }))), parse({ voiceRoleIds: [ROLE_C, ROLE_A] }), '写回再读一样');
assert.deepEqual(parse({ voiceRoleIds: [] }), parse({}), '空数组等于没写');

// 节点属性：只多 voiceRoleIds 一项。
const plan = { scenes: [{ assetId: SCENE_A, src: 'image:a', name: 'a.png' }, { assetId: SCENE_B, src: 'image:b', name: 'b.png' }], appearances: [], pictures: [] };
const propsPlain = shotQueueH3Props(plain, plan, queueOf().defaults), propsVoiced = shotQueueH3Props(voiced, plan, queueOf().defaults);
assert.deepEqual(propsVoiced.voiceRoleIds, [ROLE_C, ROLE_A]);
const { voiceRoleIds: _v, ...restVoiced } = propsVoiced;
assert.deepEqual(restVoiced, propsPlain);
assert.equal(propsVoiced.megapixels, 0.45);

// 队列校验：错的写法直接报，不猜。
const issues = (patch) => { try { parse(patch); return ''; } catch (error) { return error.message; } };
assert.match(issues({ voiceRoleIds: [ROLE_C, 'nobody'] }), /voiceRoleIds 里的角色必须都在本镜头 roleIds 里/);
assert.match(issues({ voiceRoleIds: [ROLE_C, ROLE_C] }), /voiceRoleIds不能重复|voiceRoleIds 不能重复/);
assert.match(issues({ voiceRoleIds: [ROLE_C], voiceRoleId: ROLE_C }), /voiceRoleIds 和 voiceRoleId 不能同时写/);
assert.match(issues({ voiceRoleIds: [ROLE_C], autoVoiceDisabled: true }), /autoVoiceDisabled/);
assert.match(issues({ voiceRoleIds: [ROLE_C], soundMode: 'ambient' }), /soundMode 必须是 av/);
assert.match(issues({ voiceRoleIds: [ROLE_C], dialogue: [{ roleId: ROLE_C, text: '又绕回原样了？' }] }), /dialogue 要留空/);
assert.match(issues({ voiceRoleIds: [ROLE_C], prompt: shot.prompt.replace(/^参考说明[^\n]*\n/, '') }), /参考说明/);
assert.match(issues({ voiceRoleIds: 'x' }), /voiceRoleIds/);
const four = resolveH3Speaker({ prompt: '', roleIds: ['a', 'b', 'c', 'd'], voiceRoleIds: ['a', 'b', 'c', 'd'], soundMode: 'av' });
assert.ok(four.errors.some((e) => /最多 3 个/.test(e)));
// <d> 标签那条自动路：写了 voiceRoleIds 就不再自动挑 roleIds[0]，也不报「没有说话角色」。
const tagged = resolveH3Speaker({ prompt: '<d>你好</d>', roleIds: ['a', 'b'], voiceRoleIds: ['b'], autoVoiceEnabled: true, soundMode: 'av' });
assert.equal(tagged.voiceRoleId, undefined); assert.deepEqual(tagged.voiceRoleIds, ['b']); assert.deepEqual(tagged.errors, []);
const legacy = resolveH3Speaker({ prompt: '<d>你好</d>', roleIds: ['a', 'b'], autoVoiceEnabled: true, soundMode: 'av' });
assert.equal(legacy.voiceRoleId, 'a', '旧的自动路不变');

// 角色库（只读快照）：主外观 + 主声音。
const asset = (assetId, kind, filename) => ({ assetId, kind, filename, storageReference: `${kind}:${filename}` });
const assets = new Map([
  [SCENE_A, asset(SCENE_A, 'image', 'scene-a.jpg')], [SCENE_B, asset(SCENE_B, 'image', 'scene-b.jpg')],
  ['face-role-a', asset('face-role-a', 'image', 'role-a.png')], ['face-role-b', asset('face-role-b', 'image', 'role-b.png')], ['face-role-c', asset('face-role-c', 'image', 'role-c.png')],
  ['voice-role-a', { ...asset('voice-role-a', 'audio', 'role-a.wav'), duration: 39.0 }], ['voice-role-b', { ...asset('voice-role-b', 'audio', 'role-b.wav'), duration: 50.6 }], ['voice-role-c', { ...asset('voice-role-c', 'audio', 'role-c.wav'), duration: 7.5 }],
]);
const role = (roleId, displayName, face, voice) => ({ roleId, displayName, description: '', appearanceAssetIds: [face], voiceAssetIds: voice ? [voice] : [], primaryAppearanceAssetId: face, primaryVoiceAssetId: voice });
const roles = [role(ROLE_A, '张三', 'face-role-a', 'voice-role-a'), role(ROLE_B, '李四', 'face-role-b', 'voice-role-b'), role(ROLE_C, '王五', 'face-role-c', 'voice-role-c')];
const roleAssets = Object.fromEntries([...assets.values()].map((a) => [a.assetId, a]));
const scenes = [SCENE_A, SCENE_B].map((id) => ({ assetId: id, src: assets.get(id).storageReference, name: assets.get(id).filename }));
const compileShot = (s) => compileQueueShotPictures({ shot: s, scenes, roles, assets, roleAssets, includeRoleVoices: true, noBackgroundMusic: true }).prepared;

const before = compileShot(plain), after = compileShot(voiced);
// 不送声音时，编译正文与公开示例的预期结果一致。
assert.equal(before.compiled.prompt, samplePrompt.trim());
assert.deepEqual(before.manifest.audioRefs, []);
// 只差参考说明末尾那一句。
const sentence = '<Audio 1>是王五的声音，只用于王五说话的音色；<Audio 2>是张三的声音，只用于张三说话的音色。';
assert.equal(voiceReferenceSentence([{ label: '<Audio 1>', name: '王五' }, { label: '<Audio 2>', name: '张三' }]), sentence);
const [firstBefore, ...restBefore] = before.compiled.prompt.split('\n');
const [firstAfter, ...restAfter] = after.compiled.prompt.split('\n');
assert.ok(firstBefore.startsWith('参考说明'));
assert.equal(firstAfter, firstBefore + sentence);
assert.deepEqual(restAfter, restBefore, '参考说明以外一个字都不变');
// 不加英文 binding 段、Subject、S1、元指令。
for (const banned of ['<Subject', '(S1)', 'S1,', 'Voice-timbre', 'voice-timbre', 'Do not copy', 'Role appearance', 'Spoken dialogue', 'says']) assert.ok(!after.compiled.prompt.includes(banned), banned);
// 名字只多出现在参考说明那一行。
for (const name of ['王五', '张三']) assert.equal(restAfter.join('\n').split(name).length, restBefore.join('\n').split(name).length);

// 参考清单：图片编号不动；音频按开口顺序 <Audio 1> 王五、<Audio 2> 张三，李四不送。
assert.deepEqual(after.manifest.pictureRefs.map((ref) => ref.assetId), before.manifest.pictureRefs.map((ref) => ref.assetId));
assert.deepEqual(after.manifest.audioRefs.map((ref) => [ref.label, ref.assetId]), [['<Audio 1>', 'voice-role-c'], ['<Audio 2>', 'voice-role-a']]);
assert.deepEqual(after.payload.audios.map((a) => a.filename), ['role-c.wav', 'role-a.wav']);
assert.deepEqual(after.manifest.voiceRoleIds, [ROLE_C, ROLE_A]);
assert.equal(after.manifest.roleBindings.find((b) => b.roleId === ROLE_B).audioRefIndex, null);
// 顺序跟 voiceRoleIds 走，不跟 roleIds 走。
const swapped = compileShot(parse({ voiceRoleIds: [ROLE_A, ROLE_C] }).chapters[0].shots[0]);
assert.deepEqual(swapped.manifest.audioRefs.map((ref) => ref.assetId), ['voice-role-a', 'voice-role-c']);
assert.ok(swapped.compiled.prompt.split('\n')[0].endsWith('<Audio 1>是张三的声音，只用于张三说话的音色；<Audio 2>是王五的声音，只用于王五说话的音色。'));

// 提交：ref_audios 接到 MiniMaxH3ReferenceToVideo，经 TrimAudioDuration 截前 VOICE_SAMPLE_SECONDS 秒。
const settings = { length: 209, aspect: '9:16', megapixels: 0.45, turbo: true, steps: 10, fps: 24, loraStrength: 0.75, upscaleMethod: 'lanczos', resolutionSteps: 32, soundMode: 'av', noBackgroundMusic: true };
const submit = (prepared, s) => planH3Submission({ workflowOptionId: 'community-ultimate', taskMode: 'ref2va', referenceMode: true, prompt: shot.prompt, compiledPrompt: prepared.compiled.prompt, seed: 2740032055, settings: s },
  { references: { images: prepared.payload.images.map((i) => i.filename), videos: [], audios: prepared.payload.audios.map((i) => i.filename) } }).workflow;
const voicedGraph = submit(after, { ...settings, referenceAudioTrimSeconds: VOICE_SAMPLE_SECONDS });
const node = voicedGraph['136'];
assert.equal(node.class_type, 'MiniMaxH3ReferenceToVideo');
assert.equal(voicedGraph['138'].inputs.value, after.compiled.prompt);
assert.equal(voicedGraph['129'].inputs.noise_seed, 2740032055);
assert.deepEqual(Object.keys(node.inputs).filter((k) => k.startsWith('ref_audios.')).sort(), ['ref_audios.ref_audio_0', 'ref_audios.ref_audio_1']);
for (const [i, file] of ['role-c.wav', 'role-a.wav'].entries()) {
  const trimId = node.inputs[`ref_audios.ref_audio_${i}`][0];
  assert.equal(trimId, `ff-community-audio-${i}-trim`);
  assert.deepEqual(voicedGraph[trimId], { class_type: 'TrimAudioDuration', inputs: { audio: [`ff-community-audio-${i}`, 0], start_index: 0, duration: VOICE_SAMPLE_SECONDS } });
  assert.deepEqual(voicedGraph[`ff-community-audio-${i}`], { class_type: 'LoadAudio', inputs: { audio: file } });
}
assert.equal(Object.keys(node.inputs).filter((k) => k.startsWith('ref_images.')).length, 5, '5 张图，音频不占图片名额');
assert.ok(VOICE_SAMPLE_SECONDS >= 5 && VOICE_SAMPLE_SECONDS <= 10);
const plainGraph = submit(before, settings);
assert.deepEqual(Object.keys(plainGraph['136'].inputs).filter((k) => k.startsWith('ref_audios.')), [], '对照条：一条声音都不送');
assert.ok(!Object.values(plainGraph).some((n) => n.class_type === 'TrimAudioDuration' || n.class_type === 'LoadAudio'));
// 不截的旧路（voiceRoleId 等）图里没有截短节点。
const untrimmed = submit(after, settings);
assert.deepEqual(untrimmed['136'].inputs['ref_audios.ref_audio_0'], ['ff-community-audio-0', 0]);
assert.throws(() => submit(after, { ...settings, referenceAudioTrimSeconds: 0 }), /1～30 秒/);

// 主声音缺了：提交前就报，和旧的 voiceRoleId 一样的原话（收件箱靠这句认）。
const noVoice = roles.map((r) => r.roleId === ROLE_C ? { ...r, primaryVoiceAssetId: null, voiceAssetIds: [] } : r);
let message = '';
try { compileQueueShotPictures({ shot: voiced, scenes, roles: noVoice, assets, roleAssets, includeRoleVoices: true, noBackgroundMusic: true }); } catch (error) { message = error.message; }
assert.ok(missingPrimaryVoice(message), message);
// 正文没有参考说明行：编译直接报错，不另找地方写名字。
assert.throws(() => appendVoiceReference('0-4秒：说话。', [{ label: '<Audio 1>', name: '王五' }]), /参考说明/);
// voiceRoleIds 和旧写法混用：清单直接拒。
assert.throws(() => buildReferenceManifest({ images: [], videos: [], audios: [], roles, roleAssets, dialogue: [], voiceRoleId: ROLE_C, voiceRoleIds: [ROLE_C], soundMode: 'av' }), /voiceRoleIds/);
// 角色快照：没写 voiceRoleIds 的 key 和以前一样。
assert.equal(freezeH3Roles({ roleIds: ['a'] }, { roles: [], roleAssets: {} }), freezeH3Roles({ roleIds: ['a'], voiceRoleIds: [] }, { roles: [], roleAssets: {} }));
assert.notEqual(freezeH3Roles({ roleIds: ['a'] }, { roles: [], roleAssets: {} }), freezeH3Roles({ roleIds: ['a'], voiceRoleIds: ['a'] }, { roles: [], roleAssets: {} }));

// 卡片检查。
const roleRecords = roles.map((r) => ({ ...r, updatedAt: 0, createdAt: 0 }));
const codes = (s, rr = roleRecords) => shotCardChecks(s, queueOf().defaults ? { defaults: queueOf().defaults } : {}, rr, assets).filter((c) => c.code.startsWith('voice_'));
assert.deepEqual(codes(plain), [], '没写 voiceRoleIds：不查声音（旧队列一条不多报）');
const longZhou = codes(voiced);
assert.deepEqual(longZhou.map((c) => [c.code, c.level]), [['voice_sample_long', 'warn']]);
assert.match(longZhou[0].message, /张三的声音样本有 39\.0 秒，超过 15 秒；提交时只送前 8 秒/);
assert.equal(VOICE_SAMPLE_WARN_SECONDS, 15);
const onlyRoleC = codes(parse({ voiceRoleIds: [ROLE_C] }).chapters[0].shots[0]);
assert.deepEqual(onlyRoleC.map((c) => [c.code, c.level]), [['voice_role_unlisted', 'error']]);
assert.match(onlyRoleC[0].message, /对白里张三有台词，但没写进 voiceRoleIds/);
const withRoleB = codes(parse({ voiceRoleIds: [ROLE_C, ROLE_A, ROLE_B] }).chapters[0].shots[0]).map((c) => c.code).sort();
assert.deepEqual(withRoleB, ['voice_role_silent', 'voice_sample_long', 'voice_sample_long']);
const roleCNoVoice = codes(voiced, roleRecords.map((r) => r.roleId === ROLE_C ? { ...r, primaryVoiceAssetId: null } : r));
assert.ok(roleCNoVoice.some((c) => c.code === 'voice_role_no_voice' && c.level === 'error' && /王五/.test(c.message)));

console.log('voice roles: plain 声音路只改参考说明末尾一句、ref_audios 接上并截短、卡片两条检查 OK');
