// The desktop launchers only reuse an inbox helper whose revision matches theirs.
// If inbox-server.mjs bumps INBOX_REVISION and a launcher still expects the old one,
// the shortcut reports "Inbox helper did not become ready" (or keeps reusing an old helper).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const server = readFileSync('scripts/inbox-server.mjs', 'utf8');
const revision = server.match(/INBOX_REVISION\s*=\s*'([^']+)'/)?.[1];
assert.ok(revision, 'INBOX_REVISION not found in scripts/inbox-server.mjs');

for (const launcher of ['scripts/launch-canvas.ps1', 'scripts/launch-canvas-instance.ps1']) {
  const text = readFileSync(launcher, 'utf8');
  const expected = [...text.matchAll(/revision -eq ['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(expected.length > 0, `${launcher}: no revision check found`);
  for (const value of expected) assert.equal(value, revision, `${launcher} expects inbox revision ${value}, server is ${revision}`);
}
console.log(`inbox revision ${revision}: launchers agree`);
