import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { BUILTIN_PRESETS, deleteUserPreset, loadUserPresets, matchingPreset, presetFromNode, presetToNodeProps, saveUserPreset, stepsFor, USER_PRESETS_KEY, validatePreset } from "../lib/h3-presets.ts";
import { buildH3Workflow } from "../lib/comfyui/h3-adapter.ts";
import { buildReferenceWorkflow } from "../lib/comfyui/extra-workflows.ts";
import { getMeta, putMeta } from "../lib/production-records.ts";

const store = { load: () => getMeta(USER_PRESETS_KEY), save: (presets) => putMeta(USER_PRESETS_KEY, presets) };

// Built-ins: the five required, read-only, honest about verification, never defaulting to the experimental prompt.
assert.deepEqual(BUILTIN_PRESETS.map((preset) => preset.name), ["快速测试", "高质量", "角色对话", "静音镜头", "环境声镜头"]);
assert.ok(Object.isFrozen(BUILTIN_PRESETS) && BUILTIN_PRESETS.every(Object.isFrozen));
assert.throws(() => { BUILTIN_PRESETS[0].megapixels = 0.9; }, TypeError);
assert.equal(BUILTIN_PRESETS.find((preset) => preset.name === "快速测试").verified, true);
assert.equal(BUILTIN_PRESETS.find((preset) => preset.name === "高质量").verified, false, "≈1.00MP is a candidate, not a verified default");
assert.ok(BUILTIN_PRESETS.every((preset) => preset.promptMode === "plain"), "no built-in preset turns on the experimental official-structure prompt");
assert.equal(BUILTIN_PRESETS.find((preset) => preset.name === "角色对话").mode, "ref2va");
assert.deepEqual(BUILTIN_PRESETS.map((preset) => preset.soundMode), ["av", "av", "av", "silent", "ambient"]);

// Every built-in stays inside the frozen workflows' legal ranges (built with the real builders, nothing submitted).
for (const preset of BUILTIN_PRESETS) {
  assert.doesNotThrow(() => validatePreset(preset));
  const props = presetToNodeProps(preset);
  const settings = { length: 141, aspect: props.mode, megapixels: props.megapixels, turbo: props.turbo, steps: props.steps, fps: props.fps, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: props.soundMode };
  if (preset.mode === "fl2va") {
    const workflow = buildH3Workflow("first.png", "p", 1, settings);
    assert.equal(workflow["14"].inputs.fps, 24);
    assert.equal(workflow["25"].inputs.value, preset.turbo);
    assert.equal(workflow["21"].inputs.megapixels, preset.megapixels);
    assert.equal("audio" in workflow["14"].inputs, preset.soundMode !== "silent", "silent preset removes the audio track");
  } else {
    const workflow = buildReferenceWorkflow({ images: ["ref.png"], videos: [], audios: [] }, "p", 1, settings);
    assert.equal(workflow["146"].inputs.value, preset.turbo);
    assert.equal(workflow["115"].inputs.megapixels, preset.megapixels);
  }
}
assert.deepEqual([stepsFor("fl2va", true), stepsFor("fl2va", false), stepsFor("ref2va", true), stepsFor("ref2va", false)], [6, 20, 4, 20], "steps follow Turbo exactly like the node");

// Validation rejects anything outside the frozen ranges (no clamping).
const base = { name: "x", mode: "fl2va", promptMode: "plain", aspect: "follow", megapixels: 0.5, turbo: true, fps: 24, soundMode: "av" };
assert.throws(() => validatePreset({ ...base, megapixels: 1.2 }), /0\.30–1\.00 MP/);
assert.throws(() => validatePreset({ ...base, megapixels: 0.2 }), /像素预算/);
assert.throws(() => validatePreset({ ...base, fps: 30 }), /FPS 固定为 24/);
assert.throws(() => validatePreset({ ...base, aspect: "21:9" }), /比例/);
assert.throws(() => validatePreset({ ...base, mode: "ref2va" }), /明确的画面比例/);
assert.throws(() => validatePreset({ ...base, promptMode: "official_structured" }), /首帧模式只有普通 Prompt/);
assert.throws(() => validatePreset({ ...base, name: "  " }), /名称/);
assert.equal(validatePreset({ ...base, megapixels: 0.456 }).megapixels, 0.46);

// Applying: node props; FL2VA presets leave the node's prompt mode alone.
assert.deepEqual(presetToNodeProps(BUILTIN_PRESETS[1]), { mode: "follow", megapixels: 1, turbo: false, steps: 20, fps: 24, soundMode: "av" });
assert.equal(presetToNodeProps(BUILTIN_PRESETS[2]).promptMode, "plain");
assert.equal("promptMode" in presetToNodeProps(BUILTIN_PRESETS[0]), false);

// Matching the node's current parameters.
assert.equal(matchingPreset(BUILTIN_PRESETS, { mode: "follow", megapixels: 0.5, turbo: true, soundMode: "silent" }, false).name, "静音镜头");
assert.equal(matchingPreset(BUILTIN_PRESETS, { mode: "16:9", megapixels: 0.5, turbo: true, soundMode: "av", promptMode: "plain" }, true).name, "角色对话");
assert.equal(matchingPreset(BUILTIN_PRESETS, { mode: "16:9", megapixels: 0.5, turbo: true, soundMode: "av", promptMode: "official_structured" }, true), null, "experimental prompt mode is not the built-in preset");
assert.equal(matchingPreset(BUILTIN_PRESETS, { mode: "1:1", megapixels: 0.6, turbo: true }, false), null);

// User presets: save as new, persist, reload, delete; built-ins protected; duplicates refused.
{
  const mine = presetFromNode("竖屏快剪", { mode: "9:16", megapixels: 0.6, turbo: true, soundMode: "ambient" }, false, "user:a1");
  assert.equal(mine.builtIn, false);
  assert.equal((await saveUserPreset(store, mine)).length, 1);
  const ref = presetFromNode("对话实验", { mode: "16:9", megapixels: 0.5, turbo: false, soundMode: "av", promptMode: "official_structured" }, true, "user:a2");
  assert.equal(ref.promptMode, "official_structured", "a user may save the experimental mode explicitly");
  await saveUserPreset(store, ref);
  const reloaded = await loadUserPresets(store);
  assert.deepEqual(reloaded.map((preset) => preset.name), ["竖屏快剪", "对话实验"], "restored after reload");
  assert.equal(matchingPreset([...BUILTIN_PRESETS, ...reloaded], { mode: "9:16", megapixels: 0.6, turbo: true, soundMode: "ambient" }, false).id, "user:a1");
  await assert.rejects(saveUserPreset(store, presetFromNode("快速测试", {}, false, "user:dup")), /已存在名为“快速测试”/);
  await assert.rejects(saveUserPreset(store, presetFromNode("竖屏快剪", {}, false, "user:dup2")), /已存在/);
  await assert.rejects(deleteUserPreset(store, "builtin:fast"), /内置预设不能删除/);
  await assert.rejects(saveUserPreset(store, { ...BUILTIN_PRESETS[0] }), /内置预设不能修改/);
  assert.deepEqual((await deleteUserPreset(store, "user:a1")).map((preset) => preset.id), ["user:a2"]);
  assert.deepEqual((await loadUserPresets(store)).map((preset) => preset.id), ["user:a2"]);
  // Corrupted / tampered stored entries are ignored rather than applied.
  await putMeta(USER_PRESETS_KEY, [...(await getMeta(USER_PRESETS_KEY)), { id: "user:bad", name: "坏", mode: "fl2va", promptMode: "plain", aspect: "follow", megapixels: 5, turbo: true, fps: 24, soundMode: "av" }, { id: "builtin:fake", name: "伪装", mode: "fl2va", promptMode: "plain", aspect: "follow", megapixels: 0.5, turbo: true, fps: 24, soundMode: "av", builtIn: true }]);
  assert.deepEqual((await loadUserPresets(store)).map((preset) => preset.id), ["user:a2"]);
}

console.log("H3 presets: 5 frozen built-ins inside frozen ranges (real builders), honest verification flags, no experimental default, validation, apply/match, user save/reload/delete, protection, tamper filtering passed");
