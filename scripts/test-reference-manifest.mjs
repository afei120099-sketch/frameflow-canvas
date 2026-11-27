import assert from "node:assert/strict";
import { buildReferenceManifest, loadManifestRoles, manifestPayload } from "../lib/reference-manifest.ts";
import { compileH3Prompt } from "../lib/comfyui/h3-prompt.ts";
import { compileH3Fl2vaPrompt } from "../lib/h3-prompt-compiler.ts";
import { comfyUIH3Adapter } from "../lib/comfyui/h3-adapter.ts";

const asset = (assetId, kind, filename) => ({ assetId, kind, storageReference: `${kind === "image" ? "image" : kind === "audio" ? "audio" : "media"}:${assetId}`, filename });
const assets = {
  shibaFront: asset("shibaFront", "image", "柴犬正面.png"),
  shibaSide: asset("shibaSide", "image", "柴犬侧面.png"),
  catFront: asset("catFront", "image", "橘猫正面.png"),
  shibaVoice: asset("shibaVoice", "audio", "柴犬.wav"),
  catVoice: asset("catVoice", "audio", "橘猫.wav"),
  room: asset("room", "image", "客厅.png"),
  ambience: asset("ambience", "audio", "环境声.wav"),
};
const role = (roleId, displayName, appearance, voice, extra = {}) => ({ roleId, displayName, description: "", appearanceAssetIds: appearance ? [appearance] : [], voiceAssetIds: voice ? [voice] : [], primaryAppearanceAssetId: appearance, primaryVoiceAssetId: voice, ...extra });
const shiba = () => role("shiba", "柴犬", "shibaFront", "shibaVoice");
const cat = () => role("cat", "橘猫", "catFront", "catVoice");
const explicit = (id, source) => ({ assetId: id, storageReference: assets[id].storageReference, filename: assets[id].filename, ...(source ? { source } : {}) });
const base = (overrides = {}) => ({ images: [], videos: [], audios: [], roles: [shiba(), cat()], roleAssets: { ...assets }, dialogue: [], soundMode: "av", manifestId: "m-test", createdAt: 1, ...overrides });
const LINE = "你是不是一直把装修公司的报价，当成装修总预算了？";

// Image-only community routes preserve subject/dialogue identity without voice uploads.
{
  const manifest = buildReferenceManifest(base({ includeRoleVoices: false, dialogue: [{ roleId: "shiba", text: LINE }] }));
  assert.equal(manifest.pictureRefs.length, 2);
  assert.equal(manifest.audioRefs.length, 0);
  assert.equal(manifest.speakers[0].audioRefIndex, null);
  assert.equal(manifest.dialogue[0].text, LINE);
  assert.equal(manifest.roleBindings[0].selectedVoiceAssetId, null);
}

// Test 1: two Roles, two pictures, two voices. Numbers come from the actual payload arrays.
{
  const manifest = buildReferenceManifest(base({ dialogue: [{ roleId: "shiba", text: LINE }, { roleId: "cat", text: "我没有。" }] }));
  const payload = manifestPayload(manifest);
  assert.deepEqual(payload.images.map((item) => item.assetId), ["shibaFront", "catFront"]);
  assert.deepEqual(payload.audios.map((item) => item.assetId), ["shibaVoice", "catVoice"]);
  assert.deepEqual(manifest.pictureRefs.map((ref) => [ref.label, ref.assetId]), [["<Picture 1>", "shibaFront"], ["<Picture 2>", "catFront"]]);
  assert.deepEqual(manifest.audioRefs.map((ref) => [ref.label, ref.assetId]), [["<Audio 1>", "shibaVoice"], ["<Audio 2>", "catVoice"]]);
  for (const binding of manifest.roleBindings) {
    assert.equal(payload.images[binding.pictureRefIndex - 1].assetId, binding.selectedAppearanceAssetId);
    assert.equal(payload.audios[binding.audioRefIndex - 1].assetId, binding.selectedVoiceAssetId);
  }
  assert.deepEqual(manifest.submissionOrder, { images: ["shibaFront", "catFront"], videos: [], audios: ["shibaVoice", "catVoice"] });
  assert.equal(manifest.capability, "h3_ref2va");
  assert.equal(manifest.schemaVersion, 1);
}

// Test 2: crossed numbering. 橘猫's voice is explicitly chosen first (Audio 1), 柴犬 speaks first (S1) and gets Audio 2.
{
  const manifest = buildReferenceManifest(base({ audios: [explicit("catVoice")], dialogue: [{ roleId: "shiba", text: LINE }, { roleId: "cat", text: "我没有。" }] }));
  const shibaBinding = manifest.roleBindings.find((item) => item.roleId === "shiba");
  const catBinding = manifest.roleBindings.find((item) => item.roleId === "cat");
  assert.deepEqual([shibaBinding.pictureRefIndex, shibaBinding.audioRefIndex, shibaBinding.subjectIndex, shibaBinding.speakerAlias], [1, 2, 1, "S1"]);
  assert.deepEqual([catBinding.pictureRefIndex, catBinding.audioRefIndex, catBinding.subjectIndex, catBinding.speakerAlias], [2, 1, 2, "S2"]);
  assert.equal(catBinding.voiceSource, "explicit_reference");
  assert.deepEqual(manifest.speakers.map((item) => [item.speakerId, item.roleId, item.audioRefIndex]), [["S1", "shiba", 2], ["S2", "cat", 1]]);
  // Speaker order never reorders Audio.
  assert.deepEqual(manifestPayload(manifest).audios.map((item) => item.assetId), ["catVoice", "shibaVoice"]);
}

// Required scenario: 柴犬 Picture 1 / Subject 1 / Audio 2 / S1; 橘猫 Picture 2 / Subject 2, silent, no Speaker, no Audio.
// Audio 1 is an enabled reference-video soundtrack, which ComfyUI numbers before standalone audio.
{
  const manifest = buildReferenceManifest(base({ videos: [{ ...explicit("room"), storageReference: "media:clip", filename: "客厅.mp4", assetId: "roomClip", withAudio: true }], dialogue: [{ roleId: "shiba", text: LINE }] }));
  const shibaBinding = manifest.roleBindings.find((item) => item.roleId === "shiba");
  const catBinding = manifest.roleBindings.find((item) => item.roleId === "cat");
  assert.deepEqual([shibaBinding.pictureRefIndex, shibaBinding.subjectIndex, shibaBinding.audioRefIndex, shibaBinding.speakerAlias], [1, 1, 2, "S1"]);
  assert.deepEqual([catBinding.pictureRefIndex, catBinding.subjectIndex, catBinding.audioRefIndex, catBinding.speakerAlias, catBinding.selectedVoiceAssetId], [2, 2, null, null, null]);
  assert.deepEqual(manifest.audioRefs.map((ref) => [ref.label, ref.kind, ref.assetId]), [["<Audio 1>", "video_soundtrack", "roomClip"], ["<Audio 2>", "standalone", "shibaVoice"]]);
  assert.equal(manifest.videoRefs[0].audioIndex, 1);
  assert.deepEqual(manifestPayload(manifest).audios.map((item) => item.assetId), ["shibaVoice"], "橘猫 voice is not submitted");
  assert.deepEqual(manifest.speakers.map((item) => item.speakerId), ["S1"]);
}

// Test 3: the same Asset referenced twice is submitted once with a stable number.
{
  // 客厅 is connected and also added on the node; 柴犬 and 橘猫 share one group photo as primary appearance.
  const input = () => base({ images: [explicit("room", "connected_reference"), explicit("room", "reference_image")], roles: [shiba(), role("cat2", "橘猫", "shibaFront", null)] });
  const manifest = buildReferenceManifest(input());
  assert.deepEqual(manifest.pictureRefs.map((ref) => ref.assetId), ["room", "shibaFront"]);
  assert.deepEqual(manifest.pictureRefs[0].sources, ["connected_reference", "reference_image"]);
  assert.deepEqual(manifest.roleBindings.map((binding) => binding.pictureRefIndex), [2, 2]);
  assert.deepEqual(manifest.pictureRefs[1].roleIds, ["shiba", "cat2"]);
  const again = buildReferenceManifest(input());
  assert.deepEqual(again.pictureRefs.map((ref) => ref.label), manifest.pictureRefs.map((ref) => ref.label), "deterministic");
  // Different Assets with the same content are not merged (no content hashing).
  const twins = buildReferenceManifest(base({ images: [explicit("room", "reference_image"), { ...explicit("room", "reference_image"), assetId: "roomCopy" }], roles: [] }));
  assert.equal(twins.pictureRefs.length, 2);
}

// Test 4: changing the Role primary appearance after the manifest was generated does not change it.
{
  const shibaRole = shiba();
  const roleAssets = structuredClone(assets);
  const manifest = buildReferenceManifest(base({ roles: [shibaRole, cat()], roleAssets }));
  shibaRole.primaryAppearanceAssetId = "shibaSide";
  shibaRole.appearanceAssetIds.push("shibaSide");
  roleAssets.shibaFront.filename = "changed.png";
  assert.equal(manifest.roleBindings[0].selectedAppearanceAssetId, "shibaFront");
  assert.equal(manifest.pictureRefs[0].filename, "柴犬正面.png");
  assert.deepEqual(manifest.roleBindings[0].appearanceAssetIds, ["shibaFront"]);
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.pictureRefs[0]) && Object.isFrozen(manifest.roleBindings[0].appearanceAssetIds));
  assert.throws(() => { manifest.pictureRefs[0].assetId = "x"; }, TypeError);
}

// Explicit reference that belongs to a Role wins over the Role primary.
{
  const shibaRole = role("shiba", "柴犬", "shibaFront", "shibaVoice", { appearanceAssetIds: ["shibaFront", "shibaSide"] });
  const manifest = buildReferenceManifest(base({ images: [explicit("shibaSide", "reference_image")], roles: [shibaRole] }));
  assert.equal(manifest.roleBindings[0].selectedAppearanceAssetId, "shibaSide");
  assert.equal(manifest.roleBindings[0].appearanceSource, "explicit_reference");
  assert.equal(manifest.pictureRefs.length, 1);
}

// Test 6: silent / ambient modes never submit Role voices; dialogue there is blocked explicitly.
{
  const silent = buildReferenceManifest(base({ soundMode: "silent" }));
  assert.deepEqual(silent.audioRefs, []);
  assert.deepEqual(manifestPayload(silent).audios, []);
  assert.ok(silent.roleBindings.every((binding) => binding.audioRefIndex === null && binding.speakerAlias === null));
  const ambient = buildReferenceManifest(base({ soundMode: "ambient" }));
  assert.deepEqual(ambient.audioRefs, []);
  assert.throws(() => buildReferenceManifest(base({ soundMode: "silent", dialogue: [{ roleId: "shiba", text: LINE }] })), /当前声音模式为静音，不能包含角色台词/);
  assert.throws(() => buildReferenceManifest(base({ soundMode: "ambient", dialogue: [{ roleId: "shiba", text: LINE }] })), /仅环境音/);
}

// Test 7 + explicit error cases: never silently fall back to another asset.
{
  assert.throws(() => buildReferenceManifest(base({ roles: [role("shiba", "柴犬", null, "shibaVoice")] })), /角色“柴犬”没有可用主外观/);
  assert.throws(() => buildReferenceManifest(base({ roles: [role("shiba", "柴犬", "shibaFront", null)], dialogue: [{ roleId: "shiba", text: LINE }] })), /角色“柴犬”没有可用主声音/);
  assert.throws(() => buildReferenceManifest(base({ roleAssets: { ...assets, shibaFront: null } })), /引用素材已失效/);
  assert.throws(() => buildReferenceManifest(base({ missingRoleIds: ["gone"] })), /所选角色已不存在/);
  const twoPictures = role("shiba", "柴犬", "shibaFront", null, { appearanceAssetIds: ["shibaFront", "shibaSide"] });
  assert.throws(() => buildReferenceManifest(base({ roles: [twoPictures], images: [explicit("shibaFront", "reference_image"), explicit("shibaSide", "reference_image")] })), /角色“柴犬”同时对应多个已选参考图（柴犬正面.png、柴犬侧面.png）/);
  const shared = role("cat", "橘猫", "shibaFront", null);
  assert.throws(() => buildReferenceManifest(base({ roles: [shiba(), shared], images: [explicit("shibaFront", "reference_image")] })), /参考图“柴犬正面.png”同时属于角色“柴犬”和“橘猫”/);
  assert.throws(() => buildReferenceManifest(base({ dialogue: [{ roleId: "shiba", text: "  " }] })), /第1句.*非空台词/);
  assert.throws(() => buildReferenceManifest(base({ dialogue: [{ roleId: "", text: LINE }] })), /必须填写 speaker/);
  assert.throws(() => buildReferenceManifest(base({ roles: [], images: [] })), /至少需要一项参考素材/);
}

// Legacy plain Ref2VA order (first frame, connected, node references; videos; audios) is preserved when no Role is chosen.
{
  const manifest = buildReferenceManifest(base({ roles: [], images: [explicit("shibaFront", "first_frame"), explicit("room", "connected_reference"), explicit("catFront", "reference_image")], audios: [explicit("ambience")] }));
  assert.deepEqual(manifestPayload(manifest).images.map((item) => item.assetId), ["shibaFront", "room", "catFront"]);
  assert.deepEqual(manifestPayload(manifest).audios.map((item) => item.assetId), ["ambience"]);
  assert.deepEqual(manifest.roleBindings, []);
}

// Role loading reports deleted Roles instead of skipping them.
{
  const loaded = await loadManifestRoles(["shiba", "gone"], async (id) => (id === "shiba" ? shiba() : null), async (id) => assets[id] ?? null);
  assert.deepEqual(loaded.missingRoleIds, ["gone"]);
  assert.deepEqual(Object.keys(loaded.roleAssets).sort(), ["shibaFront", "shibaVoice"]);
}

// Tests 9 + 10 retired 2026-11-10: they drove the old stable Ref2VA / FL2VA adapter, which is now blocked
// before any upload. The pure FL2VA prompt compile is still checked; community graphs have their own tests.
{
  let uploaded = 0;
  comfyUIH3Adapter.isAvailable = async () => true;
  comfyUIH3Adapter.uploadFile = async () => { uploaded++; return "x"; };
  const settings = { length: 141, aspect: "16:9", megapixels: 0.5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: "av" };
  await assert.rejects(comfyUIH3Adapter.generate({ prompt: "raw", compiledPrompt: "C", seed: 7, settings, referenceMode: true, referenceImages: [{ blob: new Blob(["a"]), name: "a.png" }] }), /已停用/);
  assert.equal(uploaded, 0, "retired workflow refuses before uploading anything");
  const flPrompt = "镜头缓缓推近，猫咪抬头。";
  assert.equal(compileH3Fl2vaPrompt({ rawPrompt: flPrompt, soundMode: "ambient" }).prompt, compileH3Prompt(flPrompt, "ambient"));
  assert.equal(compileH3Fl2vaPrompt({ rawPrompt: flPrompt, soundMode: "av" }).prompt, flPrompt);
}

console.log("Reference Manifest numbering, dedupe, Role binding, freeze, sound modes, errors and adapter payload order passed");
