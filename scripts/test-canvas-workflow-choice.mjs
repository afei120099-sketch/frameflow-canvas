import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {H3_WORKFLOW_OPTIONS,isCommunityWorkflow} from '../lib/h3-workflow-options.ts';
assert.deepEqual(H3_WORKFLOW_OPTIONS.filter(o=>isCommunityWorkflow(o.id)).map(o=>o.id),['community-ultimate','community-dialogue']);
const ui=readFileSync(new URL('../app/canvas-workspace.tsx',import.meta.url),'utf8');
assert.ok(!ui.includes('workflowOptionId: "stable"'));
assert.match(ui,/getDefaultProps\(\): H3Node\["props"\].*workflowOptionId: "community-ultimate"/);
assert.match(ui,/if \(busy \|\| recovery.blocking\) return;/);
assert.match(ui,/workflowLock === SHOT_QUEUE_LOCK \|\| current.props.workflowLock === SHOT_QUEUE_LEGACY_LOCK/);
assert.match(ui,/workflowLock === SHOT_QUEUE_LOCK/);
assert.match(ui,/workflowOptionId: SHOT_QUEUE_WORKFLOW, allReferenceMode: true, promptMode: "plain"/);
assert.match(ui,/workflowOptionId:'community-ultimate',ultimateKeyframes/);
// Video extension retired 2026-11-10; the builder was removed 2026-11-11. Nothing may create an h3-extend node.
assert.ok(!ui.includes('workflowOptionId: "h3-extend"'),'no code path creates a retired video-extension node');
const picker=readFileSync(new URL('../components/canvas/h3-workflow-picker.tsx',import.meta.url),'utf8');
assert.match(picker,/H3_WORKFLOW_OPTIONS.filter\(option => isCommunityWorkflow\(option.id\)\)/);
console.log('PASS canvas choice: two generation workflows, ultimate defaults, legacy migration, no video-extension builder');
