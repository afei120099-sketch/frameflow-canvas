import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComfyUIH3Adapter } from "../lib/comfyui/h3-adapter.ts";
import { AutopilotWorker } from "./autopilot-worker.ts";
import { ClaudeDirectorProvider } from "./director-claude.ts";
import { LocalLmStudioDirectorProvider, readGpuMemory } from "./director-lmstudio.ts";

/**
 * Real text-only planning trials (no ComfyUI, no H3). Each brief goes through the real worker with the
 * same request, schema, validator and compiler whichever provider plans: plan (≤ 2 calls) → compile →
 * freeze. (The local model stays loaded: it is only unloaded by the 【开始制作】 gate, which trials never press.)
 * Output under runtime/director-trials/<stamp>-<provider>/.
 *
 *   node --experimental-strip-types scripts/m2-director-trials.mjs --provider local [--restore]
 *   node --experimental-strip-types scripts/m2-director-trials.mjs --provider claude
 *
 * Claude: runs only when ANTHROPIC_API_KEY is set (existence is checked, the value is never printed).
 */

const BRIEFS = [
  {
    id: "A", name: "动物短剧", preset: "character", intent: "做一条30秒短视频，柴犬和橘猫聊装修为什么总超预算，轻松一点。",
    constraints: { allowDialogue: true, allowReadableText: false, allowGeneratedUI: false, allowNumbers: false, allowVoiceover: false },
    approvedFacts: ["这是轻松的朋友/夫妻式聊天", "核心内容是装修预算容易遗漏费用", "不需要出现任何真实产品界面"], forbiddenClaims: [],
  },
  {
    id: "B", name: "无对白奇观", preset: "spectacle", intent: "做一条30秒手机实拍感视频，一架现代垂直起降战斗机从公路板车上起飞，最后冲向远处天空。",
    constraints: { allowDialogue: false, allowReadableText: false, allowGeneratedUI: false, allowNumbers: true, allowVoiceover: false },
    approvedFacts: [],
    // The production setup agreed on 2026-09-27 (Subject Anchor + banned terms).
    forbiddenClaims: ["rotor", "propeller", "helicopter", "旋翼", "螺旋桨", "直升机", "standing", "upright", "vertical standing", "nose-up parked", "No action occurs", "close-up", "pallet", "first-person POV", "fan blades"],
    subjectAnchor: { subjectName: "现代垂直起降战斗机", subjectDescription: "a realistic gray modern VTOL fighter jet with long swept wings, underwing missiles, a closed cockpit canopy, an integrated vertical-lift system, and jet exhaust nozzles", sceneAnchor: "a long heavy-duty flatbed trailer on a paved public road" },
  },
  {
    id: "C", name: "产品广告", preset: "product", intent: "做一条30秒全厘宣传视频，讲清楚报价不等于装修总预算。",
    // allowVoiceover not specified by the brief → the shared default applies.
    constraints: { allowDialogue: true, allowReadableText: false, allowGeneratedUI: false, allowNumbers: false },
    approvedFacts: ["全厘是装修总预算规划工具", "核心表达：报价不等于装修总预算", "用于帮助用户梳理装修可能发生的费用", "不允许生成具体金额", "不允许生成未经批准的功能", "真实界面以后由真实截图/录屏处理，不由H3生成"],
    forbiddenClaims: ["自动省钱", "保证不超预算", "精确预测最终装修价格", "自动报价", "一键生成装修合同", "未经批准的具体节省比例"],
  },
];

const args = process.argv.slice(2);
const which = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : "local";
const restore = args.includes("--restore");
if (!["local", "claude"].includes(which)) { console.error("--provider local | claude"); process.exit(2); }
const provider = which === "claude" ? new ClaudeDirectorProvider() : new LocalLmStudioDirectorProvider();
const availability = provider.available();
if (!availability.ok) {
  // Stop before any call. For Claude this is the "no API key" stop condition.
  console.log(`【${which === "claude" ? "需要用户配置 Anthropic API Key" : "本地导演不可用"}】${availability.reason ?? ""}`);
  process.exit(3);
}

const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${which}`;
const root = fileURLToPath(new URL(`../runtime/director-trials/${stamp}`, import.meta.url));
await mkdir(root, { recursive: true });
const MODEL = "openai/gpt-oss-20b";
const loadedInstances = async () => fetch("http://127.0.0.1:1234/api/v1/models").then((r) => r.json()).then((l) => l.models.find((m) => m.key === MODEL)?.loaded_instances ?? []).catch(() => null);
const initiallyLoaded = which === "local" ? await loadedInstances() : null;
// ComfyUI is never called during planning; the adapter only satisfies the worker's constructor.
const worker = new AutopilotWorker({ root, comfy: new ComfyUIH3Adapter("http://127.0.0.1:8188", { timeoutMs: 5_000 }), python: "unused", script: "unused", directors: [provider], defaultDirector: provider.id, heartbeatMs: 5_000 });
await worker.start();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { provider: provider.id, providerVersion: provider.version, configuredModel: provider.config?.model ?? null, model: null, startedAt: new Date().toISOString(), trials: [] };
const rulesOf = (errors) => [...new Set(errors.map((error) => /\[([a-z_]+)\]/.exec(error)?.[1] ?? (/JSON|解析/.test(error) ? "invalid_json" : /调用失败/.test(error) ? "call_failed" : "other")))];

for (const brief of BRIEFS) {
  const started = Date.now();
  const job = await worker.createDraft({ intent: brief.intent, targetSeconds: 30, aspect: "9:16", preset: brief.preset, approvedFacts: brief.approvedFacts, forbiddenClaims: brief.forbiddenClaims, constraints: brief.constraints, subjectAnchor: brief.subjectAnchor ?? null });
  let ledger;
  for (;;) {
    ledger = JSON.parse(readFileSync(join(root, "jobs", `${job.jobId}.json`), "utf8"));
    if (["awaiting_confirmation", "planning_failed", "failed", "cancelled"].includes(ledger.status)) break;
    await sleep(500);
  }
  const m2 = ledger.m2;
  report.model ??= m2.attempts.find((attempt) => attempt.model)?.model ?? null;
  const trial = {
    id: brief.id, name: brief.name, intent: brief.intent, jobId: job.jobId, status: ledger.status, preset: m2.preset, constraints: m2.constraints, subjectAnchor: m2.subjectAnchor ?? null, runtimeSkill: m2.director.runtimeSkill ?? null, checks: m2.checks ?? null,
    totalWallMs: Date.now() - started, ceiling: m2.director.ceiling ?? null,
    calls: m2.attempts.map((attempt) => ({ kind: attempt.kind, ok: attempt.ok, durationMs: attempt.durationMs, usage: attempt.usage, budget: attempt.budget ?? null, transport: attempt.transport ?? [], errorCode: attempt.errorCode ?? null, billingUncertain: attempt.billingUncertain ?? false, errors: attempt.errors, rules: rulesOf(attempt.errors), rawFile: attempt.file && join(root, job.jobId, attempt.file) })),
    firstPassOk: m2.attempts[0]?.ok ?? false,
    passed: ledger.status === "awaiting_confirmation",
    repaired: m2.attempts.length > 1,
    release: m2.director.release, stageText: ledger.stageText,
    plan: m2.plan, totalSeconds: m2.totalSeconds, warnings: m2.warnings,
    approvedFacts: m2.approvedFacts, forbiddenClaims: m2.forbiddenClaims, releaseError: m2.director.releaseError ?? null,
    shots: (m2.compiled ?? []).map((shot) => ({ index: shot.index, title: shot.title, plannedSeconds: shot.plannedSeconds, length: shot.length, actualSeconds: shot.actualSeconds, semantic: shot.semantic, speakers: shot.speakers, compilerVersion: shot.compilerVersion, officialPrompt: shot.officialPrompt })),
  };
  report.trials.push(trial);
  console.log(`[${brief.id}] ${ledger.status} · calls ${trial.calls.length} · first pass ${trial.firstPassOk} · ${(trial.totalWallMs / 1000).toFixed(1)} s · shots ${trial.shots.length} · ${m2.totalSeconds?.toFixed?.(1) ?? "-"} s · rules ${JSON.stringify(trial.calls.map((call) => call.rules))}`);
  // One unfinished job at a time: close this plan (nothing was submitted) before the next brief.
  if (ledger.status === "awaiting_confirmation") await worker.cancel(job.jobId);
}

report.finishedAt = new Date().toISOString();
if (which === "local") {
  report.gpuAfter = await readGpuMemory();
  report.initiallyLoaded = initiallyLoaded;
  report.loadedAtEnd = await loadedInstances();
  // Restore only what was there before: the model was loaded at the start and is not loaded now. Never a second instance.
  if (restore && initiallyLoaded?.length && Array.isArray(report.loadedAtEnd) && report.loadedAtEnd.length === 0) {
    const response = await fetch("http://127.0.0.1:1234/api/v1/models/load", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, context_length: 8192, flash_attention: true, num_experts: 4, offload_kv_cache_to_gpu: true }) });
    report.restored = response.ok;
    report.gpuAfterRestore = await readGpuMemory();
    // TTL: the load API has no TTL field; the original instance's idle TTL is recorded as not restored, LM Studio settings untouched.
    report.ttlRestored = false;
  } else report.restored = false;
}
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), "utf8");
await worker.stop();
console.log(`report: ${join(root, "report.json")}`);
