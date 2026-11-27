import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDirectorPlan, DIRECTOR_PLAN_JSON_SCHEMA, extractPlanJson } from "../lib/autopilot-director.ts";
import { ComfyUIH3Adapter } from "../lib/comfyui/h3-adapter.ts";
import { AutopilotWorker } from "./autopilot-worker.ts";
import { ANTHROPIC_VERSION, claudeOutputSchema, ClaudeDirectorProvider, loadDirectorSettings } from "./director-claude.ts";
import { LocalLmStudioDirectorProvider } from "./director-lmstudio.ts";
import { mockPlan } from "./director-providers.ts";
import { startFakeComfy } from "./fake-comfyui.mjs";

/**
 * ClaudeDirectorProvider against a fake Anthropic Messages API, inside the real AutopilotWorker.
 * No network, no real key, no paid call, no GPU. The "key" below is a test string that must never
 * appear in any ledger, log, attempt file or error.
 */

const SECRET = "sk-ant-test-DO-NOT-LEAK-7f3a9c";
const MODEL = "claude-test-model";
const INTENT = "做一条30秒短视频，柴犬和橘猫聊装修为什么总超预算，轻松一点。";
const base = await mkdtemp(join(tmpdir(), "frameflow-claude-director-test-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanup = []; const results = [];
const valid = () => JSON.stringify(mockPlan(INTENT, 30));
const withPlan = (mutate) => { const plan = mockPlan(INTENT, 30); mutate(plan); return JSON.stringify(plan); };
const PRICE = { [MODEL]: { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 } };

/**
 * Fake Anthropic API: POST /v1/messages. Each scripted reply is a plan text (→ 200 message), or
 * { status, headers?, error?, errorCode? }, or { stop: "max_tokens" | "refusal", text? }, or { hang: true }.
 */
async function fakeAnthropic(replies = []) {
  const state = { replies: [...replies], requests: [] };
  const server = createServer((request, response) => {
    const chunks = []; request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      state.requests.push({ url: request.url, method: request.method, headers: request.headers, body, at: Date.now() });
      const send = (status, value, headers = {}) => { response.writeHead(status, { "Content-Type": "application/json", "request-id": `req_test_${state.requests.length}`, ...headers }); response.end(JSON.stringify(value)); };
      if (request.url !== "/v1/messages" || request.method !== "POST") return send(404, { type: "error", error: { type: "not_found_error", message: "unknown" } });
      if (request.headers["x-api-key"] !== SECRET) return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      const reply = state.replies.shift();
      if (reply && typeof reply === "object" && reply.hang) return; // never answers
      if (reply && typeof reply === "object" && reply.status) return send(reply.status, { type: "error", error: { type: "error", message: reply.error ?? `status ${reply.status}`, ...(reply.errorCode ? { details: { error_code: reply.errorCode } } : {}) }, request_id: "req_err" }, reply.headers ?? {});
      const stop = reply && typeof reply === "object" ? reply.stop : "end_turn";
      const text = typeof reply === "string" ? reply : reply?.text ?? "";
      send(200, {
        id: "msg_test", type: "message", role: "assistant", model: body.model, stop_reason: stop ?? "end_turn", stop_details: stop === "refusal" ? { type: "refusal", category: "test", explanation: "" } : null,
        content: [{ type: "thinking", thinking: "", signature: "sig" }, ...(text ? [{ type: "text", text }] : [])],
        usage: { input_tokens: 2100, output_tokens: 1800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

const claude = (api, extra = {}) => new ClaudeDirectorProvider({ baseUrl: api.url, model: MODEL, effort: "medium", maxTokens: 16_000, requestTimeoutMs: 5_000, maxNetworkRetries: 2, maxRetryAfterSeconds: 60, pricingUsdPerMTok: PRICE, pricingVerifiedAt: "2026-09-27", apiKey: () => SECRET, waitScale: 0.01, ...extra });

async function setup(name, provider) {
  const comfy = await startFakeComfy({ files: [], runMs: 30 });
  cleanup.push(() => comfy.close());
  const root = join(base, name);
  const worker = new AutopilotWorker({ root, comfy: new ComfyUIH3Adapter(comfy.url, { timeoutMs: 5_000 }), python: "unused", script: "unused", pollMs: 20, reconnectMs: 20, heartbeatMs: 100, directors: [provider], defaultDirector: provider.id });
  cleanup.push(() => worker.stop());
  await worker.start();
  return { comfy, root, worker };
}
const ledger = (root, id) => JSON.parse(readFileSync(join(root, "jobs", `${id}.json`), "utf8"));
const logOf = (root, id) => readFileSync(join(root, id, "autopilot.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
async function settled(root, id, statuses = ["awaiting_confirmation", "planning_failed", "completed", "failed", "cancelled"]) {
  const end = Date.now() + 60_000;
  for (;;) { const job = ledger(root, id); if (statuses.includes(job.status)) return job; if (Date.now() > end) throw new Error(`timeout ${id}`); await sleep(15); }
}
/** Every file the worker wrote under root, concatenated (ledger, log, attempt files, lock). */
const everythingWritten = (root) => { const out = []; const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else out.push(readFileSync(path, "utf8")); } }; walk(root); return out.join("\n"); };
async function test(name, fn) { const started = Date.now(); await fn(); results.push(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`); console.log(results.at(-1)); }

try {
  await test("配置与 Key：模型 ID 来自本地配置；没有 Key → 不可用、不发任何请求、给出【需要用户配置 Anthropic API Key】", async () => {
    const settings = loadDirectorSettings();
    assert.ok(settings.claude.model, "default model comes from config/director-providers.json");
    assert.ok(settings.claude.pricingUsdPerMTok[settings.claude.model], "the configured default model has a verified price row");
    const api = await fakeAnthropic([valid()]);
    const keyless = claude(api, { apiKey: () => undefined });
    assert.deepEqual(keyless.available(), { ok: false, reason: "需要用户配置 Anthropic API Key（环境变量 ANTHROPIC_API_KEY）" });
    const { root, worker } = await setup("no-key", keyless);
    await assert.rejects(worker.createDraft({ intent: INTENT }), (cause) => cause.code === "DIRECTOR_UNAVAILABLE" && /需要用户配置 Anthropic API Key/.test(cause.message));
    assert.equal(api.state.requests.length, 0);
    assert.deepEqual(readdirSync(join(root, "jobs")), []);
    // The provider object never holds the key in an enumerable / serialisable field.
    assert.ok(!JSON.stringify(claude(api)).includes(SECRET)); assert.ok(!JSON.stringify(Object.entries(claude(api))).includes(SECRET));
  });

  await test("正常规划：只发文本（brief / 规则 / 事实 / 约束），结构化 JSON Schema 输出；调用前记录上限，调用后记录官方 usage 与按价目估算的美元费用", async () => {
    const api = await fakeAnthropic([valid()]);
    const provider = claude(api);
    const { comfy, root, worker } = await setup("ok", provider);
    const job = await worker.createDraft({ intent: INTENT, approvedFacts: ["这是轻松的朋友/夫妻式聊天"], constraints: { allowDialogue: true, allowVoiceover: false } });
    const planned = await settled(root, job.jobId);
    assert.equal(planned.status, "awaiting_confirmation", planned.stageText);
    assert.equal(api.state.requests.length, 1);
    const sent = api.state.requests[0];
    assert.equal(sent.headers["anthropic-version"], ANTHROPIC_VERSION); assert.equal(sent.headers["x-api-key"], SECRET);
    assert.deepEqual(Object.keys(sent.body).sort(), ["max_tokens", "messages", "model", "output_config", "system"]);
    assert.equal(sent.body.model, MODEL); assert.equal(sent.body.output_config.effort, "medium");
    assert.equal(sent.body.output_config.format.type, "json_schema");
    const schemaText = JSON.stringify(sent.body.output_config.format.schema);
    assert.ok(!/maxItems|"minimum"|"maximum"|minLength|maxLength/.test(schemaText), "unsupported schema keywords are stripped");
    assert.ok(!("temperature" in sent.body) && !("thinking" in sent.body));
    // Text only: one user message, plain strings, nothing local.
    assert.deepEqual(sent.body.messages.map((message) => [message.role, typeof message.content]), [["user", "string"]]);
    const payload = JSON.stringify(sent.body);
    for (const leak of [JSON.stringify(base).slice(1, -1), JSON.stringify(root).slice(1, -1), "runtime", ":\\\\", "\"image\"", "\"document\"", "base64", SECRET]) assert.ok(!payload.includes(leak), `request must not contain ${leak}`);
    assert.ok(sent.body.system.includes("No voiceover or narration") && sent.body.system.includes("「这是轻松的朋友/夫妻式聊天」"));
    const attempt = planned.m2.attempts[0];
    assert.equal(attempt.ok, true); assert.equal(attempt.model, MODEL); assert.equal(attempt.providerVersion, "claude-director-v1");
    assert.equal(attempt.usage.inputTokens, 2100); assert.equal(attempt.usage.outputTokens, 1800);
    assert.equal(attempt.usage.costUsd, Number(((2100 * 4 + 1800 * 20) / 1e6).toFixed(6)));
    assert.match(attempt.usage.costBasis, /list-price estimate/);
    assert.ok(attempt.budget.maxCostUsd >= attempt.usage.costUsd && attempt.budget.maxOutputTokens === 16_000);
    assert.equal(attempt.transport.length, 1); assert.equal(attempt.transport[0].status, 200); assert.equal(attempt.transport[0].requestId, "req_test_1");
    assert.ok(planned.m2.director.ceiling.maxCostUsd > attempt.budget.maxCostUsd, "whole-stage ceiling covers the repair call too");
    // The budget was written down before the call happened.
    const log = logOf(root, job.jobId);
    const before = log.findIndex((line) => line.action === "director_plan"); const after = log.findIndex((line) => line.action === "director_plan_valid");
    assert.ok(before >= 0 && before < after && log[before].detail.budget.maxCostUsd > 0);
    assert.equal(planned.m2.director.usesLocalGpu, false); assert.equal(planned.m2.director.releasedAt, null);
    assert.equal(comfy.state.promptPosts, 0, "planning never touches ComfyUI");
    assert.ok(!everythingWritten(root).includes(SECRET));
  });

  await test("非法 JSON → 修正一次（带上一版回复 + 程序错误）→ 通过；语义失败最多修正一次；第二次仍失败 → planning_failed（正好两次调用）", async () => {
    const api = await fakeAnthropic(["这不是 JSON", valid()]);
    const { root, worker } = await setup("repair", claude(api));
    const job = await worker.createDraft({ intent: INTENT });
    const planned = await settled(root, job.jobId);
    assert.equal(planned.status, "awaiting_confirmation");
    assert.equal(api.state.requests.length, 2);
    const repair = api.state.requests[1].body.messages;
    assert.deepEqual(repair.map((message) => message.role), ["user", "assistant", "user"]);
    assert.equal(repair[1].content, "这不是 JSON"); assert.match(repair[2].content, /程序检查没有通过/);
    assert.deepEqual(planned.m2.attempts.map((attempt) => [attempt.kind, attempt.ok]), [["plan", false], ["repair", true]]);

    const dialogue = (plan) => { plan.shots[1].dialogue = [{ speaker: "subject", text: "起飞！", language: "Chinese", delivery: "a firm voice", onScreenSpeaking: true, voiceover: false }]; };
    const api2 = await fakeAnthropic([withPlan(dialogue), withPlan(dialogue), valid()]);
    const { comfy, root: root2, worker: worker2 } = await setup("repair-fail", claude(api2));
    const job2 = await worker2.createDraft({ intent: "做一条30秒手机实拍感视频，一架现代垂直起降战斗机从公路板车上起飞。", constraints: { allowDialogue: false, allowNumbers: true } });
    const failed = await settled(root2, job2.jobId);
    assert.equal(failed.status, "planning_failed"); assert.match(failed.stageText, /导演计划没有通过检查/);
    assert.equal(api2.state.requests.length, 2, "no third call");
    assert.ok(api2.state.requests[1].body.messages[2].content.includes("[no_dialogue]"), "the repair call carries the tagged rule violations");
    assert.ok(failed.m2.attempts.every((attempt) => attempt.errors.some((error) => error.includes("[no_dialogue]"))));
    assert.equal(comfy.state.promptPosts, 0); assert.equal(failed.shots.length, 0);
  });

  await test("401 / 403 → 立即失败，不重试、不修正；错误与台账里没有 Key", async () => {
    for (const status of [401, 403]) {
      const api = await fakeAnthropic([{ status, error: `bad key ${SECRET} x-api-key: ${SECRET}` }, valid()]);
      const { root, worker } = await setup(`auth-${status}`, claude(api));
      const job = await worker.createDraft({ intent: INTENT });
      const failed = await settled(root, job.jobId);
      assert.equal(failed.status, "planning_failed");
      assert.equal(api.state.requests.length, 1, "exactly one HTTP request");
      assert.equal(failed.m2.attempts.length, 1); assert.equal(failed.m2.attempts[0].errorCode, "DIRECTOR_AUTH");
      assert.match(failed.stageText, /认证 \/ 权限失败/);
      assert.ok(!everythingWritten(root).includes(SECRET), "the key never reaches ledger, log or attempt files");
    }
  });

  await test("429 遵守 retry-after 后重试（网络层，不算语义调用）；没有 retry-after / 月度额度 / 等待过长 → 不重试；5xx 有限重试；超时不重发且标记计费不确定", async () => {
    const api = await fakeAnthropic([{ status: 429, headers: { "retry-after": "40" } }, valid()]);
    const { root, worker } = await setup("429", claude(api, { waitScale: 0.02 }));
    const job = await worker.createDraft({ intent: INTENT });
    const planned = await settled(root, job.jobId);
    assert.equal(planned.status, "awaiting_confirmation");
    assert.equal(api.state.requests.length, 2);
    const waited = api.state.requests[1].at - api.state.requests[0].at;
    assert.ok(waited >= 40 * 1000 * 0.02 - 5, `waited ${waited} ms for retry-after 40 s (scaled ×0.02)`);
    assert.equal(planned.m2.attempts.length, 1, "a network retry is not a second director call");
    assert.deepEqual(planned.m2.attempts[0].transport.map((entry) => [entry.status, entry.retryAfterSeconds, entry.retried]), [[429, 40, true], [200, null, false]]);

    for (const [name, reply] of [["no-retry-after", { status: 429 }], ["spend-cap", { status: 429, errorCode: "enforced_spend_limit_reached", headers: { "retry-after": "5" } }], ["too-long", { status: 429, headers: { "retry-after": "3600" } }]]) {
      const capped = await fakeAnthropic([reply, valid()]);
      const setupCapped = await setup(`429-${name}`, claude(capped));
      const cappedJob = await setupCapped.worker.createDraft({ intent: INTENT });
      const failed = await settled(setupCapped.root, cappedJob.jobId);
      assert.equal(failed.status, "planning_failed", name); assert.equal(capped.state.requests.length, 1, name);
      assert.equal(failed.m2.attempts[0].errorCode, "DIRECTOR_RATE_LIMIT");
    }

    const flaky = await fakeAnthropic([{ status: 529 }, { status: 500 }, valid()]);
    const setupFlaky = await setup("5xx", claude(flaky));
    const flakyJob = await setupFlaky.worker.createDraft({ intent: INTENT });
    assert.equal((await settled(setupFlaky.root, flakyJob.jobId)).status, "awaiting_confirmation");
    assert.equal(flaky.state.requests.length, 3);
    const down = await fakeAnthropic([{ status: 503 }, { status: 503 }, { status: 503 }, valid()]);
    const setupDown = await setup("5xx-cap", claude(down));
    const downJob = await setupDown.worker.createDraft({ intent: INTENT });
    const downFailed = await settled(setupDown.root, downJob.jobId);
    assert.equal(downFailed.status, "planning_failed"); assert.equal(down.state.requests.length, 3, "1 + 2 network retries, then stop");

    const slow = await fakeAnthropic([{ hang: true }, valid()]);
    const setupSlow = await setup("timeout", claude(slow, { requestTimeoutMs: 300 }));
    const slowJob = await setupSlow.worker.createDraft({ intent: INTENT });
    const timedOut = await settled(setupSlow.root, slowJob.jobId);
    assert.equal(timedOut.status, "planning_failed"); assert.equal(slow.state.requests.length, 1, "a timed-out request is never re-sent");
    assert.equal(timedOut.m2.attempts[0].billingUncertain, true); assert.equal(timedOut.m2.attempts[0].errorCode, "DIRECTOR_TIMEOUT");

    const truncated = await fakeAnthropic([{ stop: "max_tokens", text: "{\"title\":" }, valid()]);
    const setupTrunc = await setup("max-tokens", claude(truncated));
    const truncJob = await setupTrunc.worker.createDraft({ intent: INTENT });
    const truncPlanned = await settled(setupTrunc.root, truncJob.jobId);
    assert.equal(truncPlanned.status, "awaiting_confirmation"); assert.equal(truncPlanned.m2.attempts[0].errorCode, "DIRECTOR_TRUNCATED");
    assert.equal(truncPlanned.m2.attempts[0].usage.outputTokens, 1800, "a truncated (billed) reply still records usage");

    const refused = await fakeAnthropic([{ stop: "refusal" }, valid()]);
    const setupRefused = await setup("refusal", claude(refused));
    const refusedJob = await setupRefused.worker.createDraft({ intent: INTENT });
    const refusedFailed = await settled(setupRefused.root, refusedJob.jobId);
    assert.equal(refusedFailed.status, "planning_failed"); assert.equal(refused.state.requests.length, 1); assert.equal(refusedFailed.m2.attempts[0].errorCode, "DIRECTOR_REFUSED");
  });

  await test("连接失败：有限次网络层重试后停止；错误里没有地址与 Key", async () => {
    const closed = createServer(); await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = closed.address().port; await new Promise((resolve) => closed.close(resolve));
    const provider = new ClaudeDirectorProvider({ baseUrl: `http://127.0.0.1:${port}`, model: MODEL, effort: "medium", requestTimeoutMs: 2_000, maxNetworkRetries: 2, pricingUsdPerMTok: PRICE, apiKey: () => SECRET, waitScale: 0.01 });
    const { root, worker } = await setup("unreachable", provider);
    const job = await worker.createDraft({ intent: INTENT });
    const failed = await settled(root, job.jobId);
    assert.equal(failed.status, "planning_failed"); assert.equal(failed.m2.attempts.length, 1);
    assert.equal(failed.m2.attempts[0].errorCode, "DIRECTOR_NETWORK");
    assert.equal(failed.m2.attempts[0].transport.length, 3, "first try + 2 retries");
    assert.ok(!failed.stageText.includes(`127.0.0.1:${port}`) && !everythingWritten(root).includes(SECRET));
  });

  await test("公平：Local 与 Claude 收到同一份 brief，同一回复经同一校验器 / 编译器得到同一结论", async () => {
    const reply = withPlan((plan) => { plan.shots[2].event = "The phone screen shows a budget app with a red button."; });
    const api = await fakeAnthropic([reply, reply]);
    const lmChats = [];
    const lmFetch = async (url, init) => {
      const path = new URL(url).pathname;
      const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/v1/models") return json({ models: [{ key: "local-model", loaded_instances: [{ id: "local-model" }] }] });
      if (path === "/api/v1/models/unload") return json({});
      lmChats.push(JSON.parse(init.body));
      return json({ model: "local-model", choices: [{ message: { content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };
    let loaded = true;
    const local = new LocalLmStudioDirectorProvider({ baseUrl: "http://lmstudio.test", model: "local-model", fetchImpl: async (url, init) => { if (new URL(url).pathname === "/api/v1/models/unload") loaded = false; if (new URL(url).pathname === "/api/v1/models") return new Response(JSON.stringify({ models: [{ key: "local-model", loaded_instances: loaded ? [{ id: "local-model" }] : [] }] }), { status: 200 }); return lmFetch(url, init); }, gpuMemory: async () => ({ usedMiB: loaded ? 15_000 : 3_000, totalMiB: 16_376 }), instanceUsage: async () => loaded ? [{ identifier: "local-model", modelKey: "local-model", status: "idle", queued: 0 }] : [], releaseSettleMs: 1 });
    const input = { intent: INTENT, approvedFacts: ["核心内容是装修预算容易遗漏费用"], forbiddenClaims: ["自动省钱"], constraints: { allowDialogue: true, allowReadableText: false, allowGeneratedUI: false, allowNumbers: false, allowVoiceover: false } };
    const outcomes = [];
    for (const [name, provider] of [["claude", claude(api)], ["local", local]]) {
      const { root, worker } = await setup(`fair-${name}`, provider);
      const job = await worker.createDraft(input);
      outcomes.push(await settled(root, job.jobId));
    }
    assert.equal(api.state.requests[0].body.system, lmChats[0].messages[0].content, "identical system brief");
    assert.equal(api.state.requests[0].body.messages[0].content, lmChats[0].messages[1].content, "identical user message");
    assert.equal(api.state.requests[1].body.messages[2].content, lmChats[1].messages[3].content, "identical repair message");
    assert.deepEqual(outcomes.map((job) => job.status), ["planning_failed", "planning_failed"]);
    assert.deepEqual(outcomes[0].m2.attempts.map((attempt) => attempt.errors), outcomes[1].m2.attempts.map((attempt) => attempt.errors), "same validator, same verdict");
    assert.ok(outcomes[0].m2.attempts[0].errors.some((error) => error.includes("[no_generated_ui]")));
    // And the verdict is exactly what the shared compiler says for that text.
    assert.deepEqual(outcomes[0].m2.attempts[0].errors, compileDirectorPlan(extractPlanJson(reply), { targetSeconds: 30, aspect: "9:16", promptMode: "official", intent: INTENT, ...input }).errors);
    assert.deepEqual(DIRECTOR_PLAN_JSON_SCHEMA.required, claudeOutputSchema().required, "same fields; only numeric / count bounds move to the validator");
  });

  console.log(`\nClaude director: ${results.length} groups passed`);
} finally {
  for (const step of cleanup.reverse()) await Promise.resolve(step()).catch(() => {});
  await rm(base, { recursive: true, force: true }).catch(() => {});
}
