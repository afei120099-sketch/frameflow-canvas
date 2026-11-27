import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCommunityWorkflow, communityTemplate } from '../lib/comfyui/experimental/h3-community.ts';
import { checkTimeAnchors, insertTimeAnchorChain, centerCropRect, unboundPictureTags, timeAnchorPromptProblem, timeAnchorFrame, H3_ULTIMATE_GUIDE } from '../lib/comfyui/experimental/h3-ultimate-guide.ts';
import { communityInputProblem } from '../lib/h3-workflow-options.ts';
import { planH3Submission } from '../lib/comfyui/h3-adapter.ts';
import { snapshotH3 } from '../lib/production-snapshots.ts';
import { captureWorkflow, lockedWorkflow } from '../lib/locked-generation.ts';
import { parseShotQueue, ShotQueueValidationError, planShotReferences, shotQueueH3Props, shotQueueWarnings } from '../lib/shot-queue.ts';
import { queueFramePlan, assertQueueFrameRemoval, resolveQueueFrameInputs, hasQueueFrameSources } from '../lib/shot-queue-frames.ts';
import { validateInboxQueue } from '../lib/inbox-queue-report.ts';

const settings = { length: 141, aspect: '16:9', megapixels: .5, turbo: true, steps: 5, fps: 24, loraStrength: 1, upscaleMethod: 'lanczos', resolutionSteps: 32, soundMode: 'av' };
const frozen = { ultimate: readFileSync('lib/comfyui/experimental/h3-community-ultimate.json', 'utf8'), dialogue: readFileSync('lib/comfyui/experimental/h3-community-dialogue.json', 'utf8') };
const chainOf = (workflow) => { const ids = []; let at = workflow['126'].inputs.conditioning; while (at[0] !== '136') { ids.push(at[0]); at = workflow[at[0]].inputs.positive; } return ids.reverse(); };

// 1. Frame math matches the official template: round(seconds × 24).
assert.equal(timeAnchorFrame(1.5), 36); assert.equal(timeAnchorFrame(3), 72); assert.equal(timeAnchorFrame(2.99), 72);

// 2. Reference path (MiniMaxH3ReferenceToVideo), both community graphs: AddGuide chain between 136 and 126.
for (const id of ['community-ultimate', 'community-dialogue']) {
  const anchors = [{ imageName: 'late.png', frameIdx: 110 }, { imageName: 'mid.png', frameIdx: 60 }];
  const workflow = buildCommunityWorkflow(id, ['scene.png'], 'A slow push in.', 7, settings, 1280, 720, undefined, [], anchors);
  const chain = chainOf(workflow);
  assert.deepEqual(chain, ['ff-anchor-0', 'ff-anchor-1'], `${id}: chained in frame order`);
  assert.equal(workflow['ff-anchor-0'].class_type, 'MiniMaxH3AddGuide');
  assert.deepEqual(workflow['ff-anchor-0'].inputs.positive, ['136', 0]);
  assert.deepEqual(workflow['ff-anchor-1'].inputs.positive, ['ff-anchor-0', 0]);
  for (const guide of chain) {
    assert.deepEqual(workflow[guide].inputs.latent, ['136', 1]);
    assert.deepEqual(workflow[guide].inputs.vae, ['119', 0]);
    assert.deepEqual(workflow[guide].inputs.audio_vae, ['120', 0]);
  }
  assert.equal(workflow['ff-anchor-0'].inputs.frame_idx, 60); assert.equal(workflow['ff-anchor-1'].inputs.frame_idx, 110);
  assert.equal(workflow['ff-anchor-0-load'].inputs.image, 'mid.png');
  assert.deepEqual(workflow['125'].inputs.latent_image, ['136', 1], 'sampler latent untouched (AddGuide outputs positive only)');
  assert.equal(workflow['136'].class_type, 'MiniMaxH3ReferenceToVideo');
  // No-anchor regression: identical graph with and without the new parameter.
  const plain = buildCommunityWorkflow(id, ['scene.png'], 'A slow push in.', 7, settings, 1280, 720);
  assert.deepEqual(buildCommunityWorkflow(id, ['scene.png'], 'A slow push in.', 7, settings, 1280, 720, undefined, [], []), plain);
  assert.deepEqual(plain['126'].inputs.conditioning, ['136', 0]);
  assert.ok(!Object.keys(plain).some((key) => key.startsWith('ff-anchor')));
  // Model / LoRA / sampler parameters identical apart from the guide chain.
  const withoutChain = structuredClone(workflow); for (const key of Object.keys(withoutChain)) if (key.startsWith('ff-anchor')) delete withoutChain[key];
  withoutChain['126'].inputs.conditioning = ['136', 0];
  assert.deepEqual(withoutChain, plain);
}
assert.equal(readFileSync('lib/comfyui/experimental/h3-community-ultimate.json', 'utf8'), frozen.ultimate, 'frozen ultimate template untouched');
assert.equal(readFileSync('lib/comfyui/experimental/h3-community-dialogue.json', 'utf8'), frozen.dialogue, 'frozen dialogue template untouched');
assert.ok(!JSON.stringify(communityTemplate('community-ultimate').template).includes('AddGuide'));

// 3. T8 path (first + last keyframes, plus a reference) keeps the same wiring.
const t8 = buildCommunityWorkflow('community-ultimate', ['first.png', 'last.png', 'role.png'], 'She turns.', 3, settings, 1280, 720, { first: 1, last: 2 }, [], [{ imageName: 'a.png', frameIdx: 70 }]);
assert.equal(t8['136'].class_type, 'MiniMaxH3AudioConditioningT8');
assert.deepEqual(chainOf(t8), ['ff-anchor-0']); assert.deepEqual(t8['125'].inputs.latent_image, ['136', 1]);
assert.throws(() => buildCommunityWorkflow('community-ultimate', ['first.png', 'last.png'], 'x', 3, settings, 1280, 720, { first: 1, last: 2 }, [], [{ imageName: 'a.png', frameIdx: 140 }]), /与尾帧同帧/);
// Pure text (T8 T2VA) also accepts anchors.
assert.deepEqual(chainOf(buildCommunityWorkflow('community-dialogue', [], 'Rain.', 3, settings, 0, 0, undefined, [], [{ imageName: 'a.png', frameIdx: 50 }])), ['ff-anchor-0']);

// 4. Limits: max 4, range [1, length-1], no duplicates; spacing < 24 frames only warns.
assert.throws(() => checkTimeAnchors([1, 2, 3, 4, 5].map((n) => ({ imageName: 'x', frameIdx: n * 20 })), 141), /最多 4 个/);
assert.throws(() => checkTimeAnchors([{ imageName: 'x', frameIdx: 0 }], 141), /超出/);
assert.throws(() => checkTimeAnchors([{ imageName: 'x', frameIdx: 141 }], 141), /超出/);
assert.throws(() => checkTimeAnchors([{ imageName: 'x', frameIdx: 60 }, { imageName: 'y', frameIdx: 60 }], 141), /同一帧/);
assert.deepEqual(checkTimeAnchors([{ imageName: 'x', frameIdx: 60 }, { imageName: 'y', frameIdx: 100 }], 141).warnings, []);
const close = checkTimeAnchors([{ imageName: 'x', frameIdx: 10 }, { imageName: 'y', frameIdx: 30 }, { imageName: 'z', frameIdx: 130 }], 141, { first: true, last: true }).warnings;
assert.equal(close.length, 3, 'near first, between anchors and near last'); assert.ok(close.every((w) => w.includes('不足 1 秒')));
assert.equal(communityInputProblem({ pictures: 1, guides: 4 }), null);
assert.match(communityInputProblem({ pictures: 1, guides: 5 }), /最多4个/);
assert.match(communityInputProblem({ pictures: 1, hasLastFrame: true }), /尾帧/);

// 5. Crop rectangle: centred, target aspect.
assert.deepEqual(centerCropRect(1920, 1080, 544, 960), { x: 654, y: 0, width: 612, height: 1080 });
assert.deepEqual(centerCropRect(1080, 1920, 960, 544), { x: 0, y: 654, width: 1080, height: 612 });
assert.deepEqual(centerCropRect(1280, 720, 960, 540), { x: 0, y: 0, width: 1280, height: 720 });
assert.throws(() => centerCropRect(0, 10, 10, 10), /无效/);

// 6. <Picture N> pointing at an anchor blocks; anchors marked as reference may be numbered.
assert.deepEqual(unboundPictureTags('<Picture 1> walks to <Picture 3>.', 2), [3]);
assert.equal(timeAnchorPromptProblem('<Picture 1> then <Picture 2>', 1, 0), null, 'no anchors: unchanged behaviour');
assert.match(timeAnchorPromptProblem('<Picture 1> then <Picture 2>', 1, 1), /不占 Picture 编号/);
assert.equal(timeAnchorPromptProblem('<Picture 1> then <Picture 2>', 2, 1), null);

// 7. Adapter plan: community + guides → chain; extend still refuses guides.
const plan = planH3Submission({ workflowOptionId: 'community-ultimate', prompt: 'Push in.', compiledPrompt: 'Push in.', seed: 5, settings, sourceWidth: 1280, sourceHeight: 720, taskMode: 'ref2va' }, { imageName: undefined, references: { images: ['scene.png'], videos: [], audios: [] }, guides: [{ imageName: 'anchor.png', frameIdx: 72 }] });
assert.deepEqual(chainOf(plan.workflow), ['ff-anchor-0']); assert.equal(plan.workflow['ff-anchor-0'].inputs.frame_idx, 72);

// 8. Snapshot records anchors under the new capability; locked replay reuses the exact graph.
const snapshotInput = { workflowOptionId: 'community-ultimate', referenceMode: true, prompt: 'Push in.', seed: 5, settings, sourceWidth: 1280, sourceHeight: 720, hasLastFrame: false, referenceCounts: { images: 1, videos: 0, audios: 0, videoAudioFlags: [] } };
const anchored = await snapshotH3({ ...snapshotInput, timeAnchors: [{ atSeconds: 3, frameIdx: 72, assetId: 'asset-a', filename: 'a.png', asReference: false, source: 'node' }] });
assert.equal(anchored.capabilityId, H3_ULTIMATE_GUIDE);
assert.deepEqual(anchored.parameters.anchorFrames, [72]); assert.equal(anchored.parameters.timeAnchors[0].assetId, 'asset-a');
assert.equal(anchored.parameters.acceptance, 'not_render_tested');
const again = await snapshotH3({ ...snapshotInput, timeAnchors: [{ atSeconds: 3, frameIdx: 72, assetId: 'asset-a', filename: 'a.png', asReference: false, source: 'node' }] });
assert.equal(again.workflowIdentity.templateVersion, anchored.workflowIdentity.templateVersion, 'identity stable for identical anchors');
assert.equal((await snapshotH3(snapshotInput)).capabilityId, 'h3_ref2va', 'no anchors: capability unchanged');
const captured = await captureWorkflow(plan.workflow, '148');
const locked = await lockedWorkflow({ submissionSnapshot: captured, seed: 5, finalPrompt: 'Push in.', status: 'completed' });
assert.deepEqual(locked.graph, plan.workflow, 'locked rerun replays the AddGuide nodes and frames verbatim');

// 9. Queue JSON: timeAnchors parse, errors, no-anchor regression.
const base = { title: 'Main', shotId: 'S01', prompt: 'A room at dusk.', roleIds: [], sceneAssetIds: [], seconds: 6, aspect: '16:9', soundMode: 'ambient' };
const make = (shots) => ({ version: 'shot-queue-v1', title: 'anchors', chapters: [{ title: 'one', shots }] });
const plainQueue = parseShotQueue(JSON.stringify(make([base])));
assert.ok(!('timeAnchors' in plainQueue.chapters[0].shots[0]), 'no field → no timeAnchors key');
assert.equal(hasQueueFrameSources(plainQueue.chapters[0].shots[0]), false);
const okQueue = parseShotQueue(JSON.stringify(make([base, { ...base, title: 'Anchored', shotId: 'S02', timeAnchors: [{ atSeconds: 4.5, assetId: 'img-1' }, { atSeconds: 2, frameFrom: { shotId: 'S01', frame: 'last' } }] }])));
assert.equal(okQueue.chapters[0].shots[1].timeAnchors.length, 2);
assert.deepEqual(queueFramePlan(okQueue).dynamic, ['0:1'], 'frameFrom anchors join the dependency plan');
assert.throws(() => assertQueueFrameRemoval(okQueue, 0, 0), /仍依赖/);
const errorsOf = (shot) => { try { parseShotQueue(JSON.stringify(make([base, { ...base, title: 'Bad', shotId: 'S09', ...shot }]))); return ''; } catch (error) { assert.ok(error instanceof ShotQueueValidationError); return error.message; } };
assert.match(errorsOf({ timeAnchors: [1, 2, 3, 4, 5].map((n) => ({ atSeconds: n, assetId: `i${n}` })) }), /最多 4/);
assert.match(errorsOf({ timeAnchors: [{ atSeconds: 2, assetId: 'a', frameFrom: { shot: 'Main', frame: 'last' } }] }), /只能指定 assetId 或 frameFrom/);
assert.match(errorsOf({ timeAnchors: [{ atSeconds: 99, assetId: 'a' }] }), /超出/);
assert.match(errorsOf({ timeAnchors: [{ atSeconds: 2, assetId: 'a' }, { atSeconds: 2.01, assetId: 'b' }] }), /同一帧/);
assert.match(errorsOf({ generationMode: 'first-last', lastFrameAssetId: 'last', timeAnchors: [{ atSeconds: 140 / 24, assetId: 'a' }] }), /与尾帧同帧/);
assert.match(errorsOf({ generationMode: 'extend', sourceShot: 'Main', timeAnchors: [{ atSeconds: 2, assetId: 'a' }] }), /已停用/);
assert.match(errorsOf({ prompt: 'The room becomes <Picture 1>.', timeAnchors: [{ atSeconds: 2, assetId: 'a' }] }), /不占 Picture 编号/);
assert.equal(errorsOf({ prompt: 'The room becomes <Picture 1>.', timeAnchors: [{ atSeconds: 2, assetId: 'a', asReference: true }] }), '', 'asReference anchors may be numbered');
assert.match(errorsOf({ timeAnchors: [{ atSeconds: 2, frameFrom: { shot: 'Bad', frame: 'last' } }] }), /循环|自身/);
assert.match(errorsOf({ timeAnchors: [{ atSeconds: 2, assetId: 'a', extra: 1 }] }), /多出/);
const spaced = parseShotQueue(JSON.stringify(make([base, { ...base, title: 'Close', shotId: 'S03', timeAnchors: [{ atSeconds: 2, assetId: 'a' }, { atSeconds: 2.5, assetId: 'b' }] }])));
assert.ok(shotQueueWarnings(spaced).some((w) => w.includes('不足 1 秒')), 'spacing under 1 s warns, never blocks');

// 10. Node props: static anchors resolved, absent field leaves props unchanged.
const assets = new Map([['img-1', { assetId: 'img-1', kind: 'image', filename: 'beat.png', storageReference: 'image:beat' }]]);
const anchoredShot = okQueue.chapters[0].shots[1];
const shotPlan = planShotReferences(anchoredShot, [], assets);
assert.deepEqual(shotPlan.anchors, [{ assetId: 'img-1', src: 'image:beat', name: 'beat.png', atSeconds: 4.5, asReference: false }]);
assert.deepEqual(shotQueueH3Props(anchoredShot, shotPlan).timeAnchors, [{ assetId: 'img-1', storageReference: 'image:beat', filename: 'beat.png', atSeconds: 4.5 }]);
assert.ok(!('timeAnchors' in shotQueueH3Props(plainQueue.chapters[0].shots[0], planShotReferences(plainQueue.chapters[0].shots[0], [], assets))));
assert.throws(() => planShotReferences({ ...anchoredShot, timeAnchors: [{ atSeconds: 2, assetId: 'missing' }] }, [], assets), /时间锚点图不存在/);

// 11. Dry run: static anchors resolved, frameFrom anchors deferred, missing asset reported.
const report = validateInboxQueue(make([base, { ...base, title: 'Anchored', shotId: 'S02', timeAnchors: [{ atSeconds: 4.5, assetId: 'local-beat' }, { atSeconds: 2, frameFrom: { shotId: 'S01', frame: 'last' } }] }]), { 'local-beat': 'img-1' }, [...assets.values()], [], true);
assert.equal(report.ok, true, report.errors.join('\n'));
const compiled = report.compiledShots[1];
assert.equal(compiled.state, 'deferred');
assert.deepEqual(compiled.timeAnchors.map((a) => [a.atSeconds, a.frameIdx, a.status, a.pictureNumber]), [[2, 48, 'deferred', false], [4.5, 108, 'resolved', false]]);
assert.equal(compiled.timeAnchors[1].assetId, 'img-1');
assert.ok(report.assets.some((a) => a.field === 'timeAnchors[1].frameFrom' && a.status === 'deferred'));
const missing = validateInboxQueue(make([{ ...base, timeAnchors: [{ atSeconds: 2, assetId: 'nope' }] }]), {}, [...assets.values()], [], true);
assert.equal(missing.ok, false); assert.ok(missing.errors.some((e) => e.includes('timeAnchors[0].assetId')));

// 12. Execution: a frameFrom anchor is extracted and frozen like first / last, never HD-enhanced.
const session = { id: 's', pageId: 'p', queue: okQueue, entries: [{ chapter: 0, shot: 0, nodeId: 'node-a' }, { chapter: 0, shot: 1, nodeId: 'node-b' }] };
const run = { runId: 'r1', ownerNodeId: 'node-a', status: 'completed', submission: 'accepted', createdAt: 1, outputAssetIds: ['v1'] };
const saved = []; let enhanced = 0;
const inputs = await resolveQueueFrameInputs(session, session.entries[1], {
  guard() {}, runs: async () => [run], asset: async () => ({ assetId: 'v1', kind: 'video', filename: 'main.mp4', storageReference: 'media:main' }),
  read: async () => new Blob(['video']), pause: async () => {}, extract: async () => ({ dataUrl: 'data:image/png;base64,WA==', seconds: 5.9, width: 320, height: 180 }),
  storeFrame: async () => 'image:anchor-frame', saveFrame: async (edge, input) => { saved.push([edge, input.src]); }, enhanceTail: async (input) => { enhanced++; return input; },
});
assert.deepEqual(Object.keys(inputs), ['anchor:1']); assert.equal(inputs['anchor:1'].src, 'image:anchor-frame');
assert.deepEqual(saved, [['anchor:1', 'image:anchor-frame']]); assert.equal(enhanced, 0, 'anchors are cropped at submit, not HD-enhanced');

console.log('PASS h3_ultimate_guide: AddGuide chain on ultimate/fast (reference, T8, text), frozen templates untouched, frame math/limits/spacing warnings, crop, unbound <Picture N> blocking, snapshot + locked replay, queue timeAnchors parse/errors/no-anchor regression, dependency plan, dry-run report, anchor extraction; no GPU');
