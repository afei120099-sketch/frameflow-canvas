import assert from "node:assert/strict";
import { h3PromptHealth, tuningOfParameters } from "../lib/h3-prompt-health.ts";
import { UNDERSTANDING_VALUES } from "../lib/comfyui/experimental/h3-community-controls.ts";
import { shotHealth } from "../lib/shot-queue.ts";

const codes = (prompt, context) => h3PromptHealth(prompt, { seconds: 6, ...context }).map((h) => h.code).sort();

// A well-written shot gets no hints.
const clean = "<Picture 1> is the first frame. A man in a black shirt stands in a dim hotel corridor, warm wall lamps. He slowly raises his head and looks at the camera. Sound: soft footsteps on the carpet, quiet corridor ambience.";
assert.deepEqual(codes(clean, { firstFrame: true, soundMode: "ambient" }), []);

// 1. 「否定写法」检查已删：和正本「画面要求」（没有字幕、水印或文字叠加；不要互换脸）冲突。
assert.ok(!codes("Empty terrace, no people, never any birds. Wind.", {}).includes("negation"));
assert.ok(!codes("画面要求：竖屏9:16，没有字幕、水印或文字叠加，不要互换脸。声音：风声。", {}).includes("negation"));

// 2. First-frame shots that open with an action.
assert.ok(codes("<Picture 1> is the first frame. He turns and walks to the door. Footsteps.", { firstFrame: true }).includes("first_sentence"));
assert.ok(!codes("<Picture 1> is the first frame. He turns and walks to the door. Footsteps.", { firstFrame: false }).includes("first_sentence"));

// 3. Soundscape: missing → hint; overall_soundscape field, sound words, dialogue or silent mode → none.
assert.ok(codes("A ship sails across the sea at dusk.", { soundMode: "av" }).includes("soundscape"));
assert.ok(!codes("A ship sails at dusk. overall_soundscape: Iron hull groan, chain rattle. non_diegetic_music: N/A", { soundMode: "av" }).includes("soundscape"));
assert.ok(codes("A ship sails at dusk. overall_soundscape: N/A", { soundMode: "av" }).includes("soundscape"));
assert.ok(!codes("A ship sails across the sea at dusk.", { soundMode: "silent" }).includes("soundscape"));
assert.ok(!codes("A ship sails across the sea at dusk.", { hasDialogue: true }).includes("soundscape"));

// 4. Off-screen speakers.
assert.ok(codes("She stands by the window. Rain.", { offscreen: true }).includes("offscreen"));
assert.ok(!codes("She stands by the window, mouth stays closed. He says in an off-screen voiceover. Rain.", { offscreen: true }).includes("offscreen"));

// 5. Timeline overflow and density.
assert.ok(codes("[0s-3s] He sits. [3s-9s] He stands up. Footsteps.", { seconds: 6 }).includes("timeline_overflow"));
assert.ok(!codes("[0s-3s] He sits. [3s-6s] He stands up. Footsteps.", { seconds: 6 }).includes("timeline_overflow"));
assert.ok(codes("[0s-1s] a. [1s-2s] b. [2s-3s] c. [3s-4s] d. [4s-5s] e. Wind.", { seconds: 5 }).includes("too_many_beats"));
assert.ok(!codes("[0s-2s] a. [2s-4s] b. [4s-6s] c. [6s-7s] d. Wind.", { seconds: 7 }).includes("too_many_beats"), "7 s / 4 beats worked in the GPU test");

// 6. Fights / many beats on the accelerated graph only; idioms and staging words are not fights.
assert.ok(codes("He draws his sword and slashes at the monster. Steel ring.", {}).includes("fight_accelerated"));
assert.ok(codes("二人交手，挥剑劈向对方。风声。", {}).includes("fight_accelerated"));
assert.ok(!codes("He draws his sword and slashes at the monster. Steel ring.", { tuning: "understanding" }).includes("fight_accelerated"));
assert.ok(!codes("She fights a smile and looks away. Blocking: one actor left. 剑眉微挑，手掌放在桌上。Wind.", {}).includes("fight_accelerated"));
assert.ok(codes("[0s-2s] a. [2s-4s] b. [4s-6s] c. [6s-7s] d. Wind.", { seconds: 7 }).includes("beats_accelerated"));

// Tuning detection from node parameters and queue shots.
assert.equal(tuningOfParameters(JSON.stringify(UNDERSTANDING_VALUES)), "understanding");
assert.equal(tuningOfParameters(JSON.stringify({ "community-ultimate": { ...UNDERSTANDING_VALUES } })), "understanding");
assert.equal(tuningOfParameters(undefined), "default");
assert.equal(tuningOfParameters("{bad json"), "default");
const fightShot = { title: "t", prompt: "He swings his sword and slashes. Steel ring.", roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "av" };
assert.ok(shotHealth(fightShot).some((m) => m.includes("理解优先")));
assert.ok(!shotHealth({ ...fightShot, tuning: "understanding" }).some((m) => m.includes("理解优先")));
assert.ok(shotHealth({ ...fightShot, tuning: "understanding", workflow: "fast" }).some((m) => m.includes("理解优先")), "fast graph is accelerated regardless");
console.log("h3 prompt health: ok");
