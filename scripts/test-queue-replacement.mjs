/*
 * 原来想保护什么：
 * 1. 旧批次节点全部从画布删除后，再次明确提交相同或不同队列时，应把旧会话完整归档（保留删除/暂停/失败墓碑），并创建全新独立会话与新节点，绝不复活已删除的旧节点。
 * 2. 已删除节点的失败记录不能被「重试失败镜头」误重提；若旧节点仍有 queued/running 任务，或存在尚未在 ComfyUI 确认终态（completed/failed）的已登记 Run（started/accepted/uncertain），必须阻止替换提交。
 * 3. 面板 UI 仅在已载入队列且存在明确失败项时展示重试按钮，未载入队列时给出新队列导入引导。
 *
 * 为什么原写法失效：
 * 产品代码 components/use-shot-queue-execution.ts（allRemoved 检查分支）已明确演进：
 * Run 记录在调用 /prompt 之前就会先落盘；若已删除节点没有任何 Run 记录（例如本地「项目正在恢复」阶段被拦截），它不可能在 ComfyUI 里占位，因此不再把「无 Run 的已删除 started 条目」视为待确认 GPU 任务。原测试第 28–30 行用 runs: [] 构造 started 场景，继续断言必须拦截，导致与现行产品行为冲突而失败。
 *
 * 新写法怎么保护同一件事：
 * 1. 完整保留全部运行时行为检查（全删后同队列/新队列替换、旧会话归档完整性、不复活旧节点、retryFailed 拒绝已删镜头、queued/running 拦截、accepted + probe 终态放行/非终态拦截）。
 * 2. 将原 started/uncertain 场景拆分为两条更精确的行为断言：
 *    - 已删除且无任何 Run 记录的 started 条目：允许归档旧会话并新建独立批次（不复活旧节点）；
 *    - 已删除且存在 Run 记录（无 comfyPromptId 或 probe 返回 not_found）的 started / uncertain 条目：仍严格拦截并提示「待确认」。
 * 3. 保留面板重试按钮门控与空态导入引导检查。
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-queue-fail-closed.mjs';
import {parseShotQueue} from '../lib/shot-queue.ts';
import {newQueueSession} from '../lib/shot-queue-session.ts';

const queue=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'replacement CPU',chapters:[{title:'one',shots:[{title:'one',prompt:'CPU only',seconds:6,aspect:'16:9',roleIds:[],sceneAssetIds:[],autoVoiceDisabled:true}]}]}));
const old=newQueueSession('page:g-test',queue,{x:0,y:0});
old.autoContinueFrames=false;old.stoppedAt=10;
Object.assign(old.entries[0],{nodeId:'shape:deleted',removedAt:10,outcome:'failed',submissionState:'pending'});
const original=JSON.stringify(old);

// 1. 全删后提交相同队列：归档旧墓碑、建独立新会话、绝不复活已删节点
const same=harness({queue,saved:old});same.editor.shapes.clear();await same.api.submitAll();
assert.notEqual(same.data.saved.id,old.id,'identical replacement after full deletion creates a new session');
assert.equal(same.data.created.length,1);assert.equal(same.data.submitted.length,1);
assert.notEqual(same.data.submitted[0],'shape:deleted');
assert.equal(JSON.stringify(same.data.metaWrites.find(w=>w.key===`shot-queue-session-archive-v1:${old.id}`)?.value),original,'archive preserves all original deletion/pause/error records');
assert.equal(same.editor.shapes.has('shape:deleted'),false,'deleted node never restored');

// 2. 全删后点「重试失败镜头」：拒绝重建或重提
const retry=harness({queue,saved:old});retry.editor.shapes.clear();await retry.api.retryFailed();
assert.equal(retry.data.created.length,0);assert.equal(retry.data.submitted.length,0);
assert.match(retry.data.messages.at(-1),/没有可重试/);

// 3. 旧节点仍有 queued / running 任务：严禁替换提交
for(const status of ['queued','running']){
  const h=harness({queue,saved:old,runs:[{runId:'r',ownerNodeId:'shape:deleted',status,createdAt:1,comfyPromptId:'p',submission:'accepted'}]});
  h.editor.shapes.clear();await h.api.submitAll();
  assert.equal(h.data.created.length,0,`active ${status} run blocks replacement node creation`);
  assert.equal(h.data.submitted.length,0,`active ${status} run blocks replacement submission`);
  assert.match(h.data.messages.at(-1),/旧镜头仍有/);
}

// 4a. 已删除且无任何 Run 记录的 started 条目：从未预约 /prompt，允许归档旧会话并新建批次（不复活旧节点）
const localStartedNoRun=structuredClone(old);localStartedNoRun.entries[0].submissionState='started';
const allowedNoRun=harness({queue,saved:localStartedNoRun,runs:[]});allowedNoRun.editor.shapes.clear();await allowedNoRun.api.submitAll();
assert.notEqual(allowedNoRun.data.saved.id,old.id,'deleted started entry without any Run archives old session');
assert.equal(allowedNoRun.data.created.length,1);assert.equal(allowedNoRun.data.submitted.length,1);
assert.equal(allowedNoRun.editor.shapes.has('shape:deleted'),false,'deleted node never restored even when replacement allowed');

// 4b. 已删除但存在 Run 记录的 started / uncertain 条目：若无 promptId 或 ComfyUI 历史未确认终态，必须拦截
const startedWithReservedRun=structuredClone(old);startedWithReservedRun.entries[0].submissionState='started';
const unknownNoPrompt=harness({queue,saved:startedWithReservedRun,runs:[{runId:'r-reserved',ownerNodeId:'shape:deleted',status:'failed',createdAt:1,submission:'reserved'}]});
unknownNoPrompt.editor.shapes.clear();await unknownNoPrompt.api.submitAll();
assert.equal(unknownNoPrompt.data.created.length,0,'started entry with unconfirmed Run blocks replacement');
assert.equal(unknownNoPrompt.data.submitted.length,0);
assert.match(unknownNoPrompt.data.messages.at(-1),/待确认/);

const uncertainWithUnprobedRun=structuredClone(old);uncertainWithUnprobedRun.entries[0].outcome='uncertain';
const unknownNotFound=harness({queue,saved:uncertainWithUnprobedRun,runs:[{runId:'r-uncertain',ownerNodeId:'shape:deleted',status:'failed',createdAt:1,comfyPromptId:'p',submission:'accepted'}],hooks:{probeState:'not_found'}});
unknownNotFound.editor.shapes.clear();await unknownNotFound.api.submitAll();
assert.equal(unknownNotFound.data.created.length,0,'uncertain entry with not_found probe blocks replacement');
assert.equal(unknownNotFound.data.submitted.length,0);
assert.match(unknownNotFound.data.messages.at(-1),/待确认/);

// 5. accepted 条目仅在 ComfyUI probe 确认终态（failed/completed）后允许替换
const receipt=structuredClone(old);receipt.entries[0].submissionState='accepted';
const failedRun={runId:'r',ownerNodeId:'shape:deleted',status:'failed',createdAt:1,comfyPromptId:'p',submission:'accepted'};
for(const probeState of ['not_found','failed']){
  const h=harness({queue,saved:receipt,runs:[failedRun],hooks:{probeState}});h.editor.shapes.clear();await h.api.submitAll();
  assert.equal(h.data.submitted.length,probeState==='failed'?1:0,'only confirmed terminal original history permits identical replacement');
}

// 6. 新队列（标题/内容不同）直接归档旧会话并新建独立批次
const changed={...queue,title:'new independent queue'};
const next=harness({queue:changed,saved:old});next.editor.shapes.clear();await next.api.submitAll();
assert.equal(next.data.created.length,1);assert.equal(next.data.submitted.length,1);assert.notEqual(next.data.saved.id,old.id);

// 7. 面板 UI 约束：仅在有队列且有明确失败项时展示重试；无队列时给出新队列导入引导
const panel=readFileSync('components/shot-queue-panel.tsx','utf8');
assert.match(panel,/queue\s*&&\s*execution\.failedCount\s*>\s*0/);
assert.match(panel,/新队列请在上方选择 JSON 文件/);
console.log('PASS queue replacement: behavioral checks for archive/new-session, no-run vs unconfirmed-run started guards, terminal probe gating, and panel retry/import guidance. CPU only.');
