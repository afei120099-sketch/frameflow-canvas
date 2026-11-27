import assert from 'node:assert/strict';
import { parseH3Dialogue } from '../lib/h3-dialogue.ts';
import { parseShotQueue } from '../lib/shot-queue.ts';

const baseShot = {
  title: 'No dialogue', prompt: 'An empty room.', roleIds: ['host'],
  sceneAssetIds: [], seconds: 6, aspect: '16:9', soundMode: 'av',
};
const parse = (patch) => parseShotQueue(JSON.stringify({
  version: 'shot-queue-v1', title: 'Dialogue regression',
  chapters: [{ title: 'Test', shots: [{ ...baseShot, ...patch }] }],
}), false).chapters[0].shots[0];

const withoutDialogue = parse({});
for (const [label, patch] of [
  ['omitted', {}], ['null', { dialogue: null }], ['empty array', { dialogue: [] }],
]) {
  assert.deepEqual(parseH3Dialogue(patch.dialogue, ['host'], 'dialogue'), []);
  assert.deepEqual(parse(patch), withoutDialogue);
  console.log(`PASS no dialogue: ${label}`);
}

const role = { roleId: 'host', text: 'Hello.' };
const guest = { speaker: 'Narrator', voice: 'none', text: 'Years later.' };
assert.deepEqual(parse({ dialogue: [role] }).dialogue, [role]);
assert.deepEqual(parse({ dialogue: [guest] }).dialogue, [{ roleId: '', ...guest }]);
assert.equal(parse({ dialogue: [{ speaker: 'Narrator', text: 'Hello.' }] }).dialogue[0].voice, 'none');
assert.equal(parse({ dialogue: [{ ...guest, voice: 'audio:voice-id' }] }).dialogue[0].voice, 'audio:voice-id');
assert.equal(parse({ dialogue: Array.from({ length: 100 }, () => role) }).dialogue.length, 100);

for (const [label, dialogue, error] of [
  ['string', '', /dialogue 数组/],
  ['object', {}, /dialogue 数组/],
  ['false', false, /dialogue 数组/],
  ['zero', 0, /dialogue 数组/],
  ['101 lines', Array.from({ length: 101 }, () => role), /dialogue 数组/],
  ['null element', [null], /格式错误/],
  ['array element', [[]], /格式错误/],
  ['empty text', [{ ...role, text: ' ' }], /text/],
  ['unknown role', [{ ...role, roleId: 'other' }], /roleId/],
  ['mixed speaker', [{ ...role, speaker: 'Narrator' }], /不能混用/],
  ['mixed voice', [{ ...role, voice: 'none' }], /不能混用/],
  ['missing speaker', [{ text: 'Hello.' }], /speaker/],
  ['invalid voice', [{ ...guest, voice: 'file.wav' }], /voice/],
]) {
  assert.throws(() => parseH3Dialogue(dialogue, ['host'], 'dialogue'), error);
  assert.throws(() => parse({ dialogue }), error);
  console.log(`PASS rejected: ${label}`);
}
console.log('PASS dialogue normalization and queue integration; existing dialogue validation retained.');
