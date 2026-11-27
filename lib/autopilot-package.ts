import { z } from "zod";
import {
  DirectorCharacterSchema, DirectorShotSchema, DIRECTOR_CONSTRAINT_KEYS, MACHINE_MESSAGE, MACHINE_SYNTAX, M2_ASPECTS, M2_INTENT_MAX, M2_PRESET_IDS, M2_SECONDS_RANGE, normalizeSubjectAnchor,
  type DirectorConstraints, type DirectorPlan, type M2Aspect, type M2PresetId, type SubjectAnchor,
} from "./autopilot-director.ts";

/**
 * Director Plan Package (director-plan-package-v1): how a director plan enters Autopilot M2 from outside —
 * today pasted from a GPT / Claude chat window, later returned by an API provider. It carries the request the
 * plan was made for plus the semantic DirectorPlan (the same shot fields the local director fills). It never
 * carries a video-model prompt: unknown fields are refused, machine syntax in any text is refused, and the
 * final H3 prompt is always produced by the local deterministic compiler.
 *
 * Nothing here trusts the package: the worker re-validates everything (schema, request match, hard constraints,
 * facts, anchor, camera, compiler, preflight) before a job may exist.
 */

export const DIRECTOR_PLAN_PACKAGE_VERSION = "director-plan-package-v1";
export const DIRECTOR_PLAN_PACKAGE_MAX_CHARS = 200_000;
export type PlanSource = "external_ai" | "local_lmstudio" | "mock" | "cloud_api";
export const EXTERNAL_PROVIDER_LABELS = ["GPT", "Claude", "other"] as const;
export type ExternalProviderLabel = (typeof EXTERNAL_PROVIDER_LABELS)[number];

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !MACHINE_SYNTAX.test(value), { message: MACHINE_MESSAGE });

/** Same shot fields as DirectorShotSchema (sounds / claims lists may be omitted); nothing else is accepted. */
const PackageShotSchema = DirectorShotSchema.extend({
  nonVerbalSounds: DirectorShotSchema.shape.nonVerbalSounds.default([]),
  productClaims: DirectorShotSchema.shape.productClaims.default([]),
}).strict();

export const DirectorPlanPackageSchema = z.object({
  packageVersion: z.literal(DIRECTOR_PLAN_PACKAGE_VERSION),
  project: z.object({
    title: text(60),
    brief: text(M2_INTENT_MAX),
    targetDurationSeconds: z.number().min(M2_SECONDS_RANGE.min).max(M2_SECONDS_RANGE.max),
    aspectRatio: z.enum(M2_ASPECTS),
    preset: z.enum(M2_PRESET_IDS),
  }).strict(),
  constraints: z.object({
    allowDialogue: z.boolean(), allowVoiceover: z.boolean(), allowReadableText: z.boolean(), allowGeneratedUI: z.boolean(), allowNumbers: z.boolean(),
    forbiddenTerms: z.array(text(80)).max(40).default([]),
  }).strict(),
  subjectAnchor: z.object({ subjectName: z.string().max(40).default(""), subjectDescription: z.string().max(300), sceneAnchor: z.string().max(300).default("") }).strict().nullable().default(null),
  approvedFacts: z.array(text(200)).max(20).default([]),
  forbiddenClaims: z.array(text(200)).max(40).default([]),
  plan: z.object({
    summary: text(300),
    style: text(160),
    characters: z.array(DirectorCharacterSchema.strict()).max(4),
    shots: z.array(PackageShotSchema).min(1).max(12),
  }).strict(),
}).strict();
export type DirectorPlanPackage = z.infer<typeof DirectorPlanPackageSchema>;

/** What the canvas asked the director for (the request the package must answer, field for field). */
export interface DirectorPackageRequest {
  brief: string;
  targetDurationSeconds: number;
  aspectRatio: M2Aspect;
  preset: M2PresetId;
  constraints: DirectorConstraints & { forbiddenTerms: string[] };
  subjectAnchor: SubjectAnchor | null;
  approvedFacts: string[];
  forbiddenClaims: string[];
}

/**
 * Only two accepted shapes: the JSON object itself, or exactly one ```json fenced block with nothing around it.
 * Prose around the JSON is refused (no guessing where the JSON might be).
 */
export function unwrapPackageText(raw: string): string {
  if (typeof raw !== "string") throw new Error("计划包必须是文本");
  if (raw.length > DIRECTOR_PLAN_PACKAGE_MAX_CHARS) throw new Error(`计划包太长（上限 ${DIRECTOR_PLAN_PACKAGE_MAX_CHARS} 个字符）`);
  const trimmed = raw.replace(/^﻿/, "").trim();
  if (!trimmed) throw new Error("请先粘贴 GPT / Claude 返回的导演计划 JSON");
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/i.exec(trimmed);
  const body = fence ? fence[1].trim() : trimmed;
  if (!body.startsWith("{")) throw new Error("只能粘贴 JSON 本身（或一个 ```json 代码块），不要夹带说明文字");
  return body;
}

export type PackageParseResult = { ok: true; pkg: DirectorPlanPackage; canonical: string } | { ok: false; errors: string[] };

/** Parse + schema check. Pure data: never evaluates anything, never follows paths or commands in the text. */
export function parseDirectorPlanPackage(raw: string): PackageParseResult {
  let body: string;
  try { body = unwrapPackageText(raw); } catch (cause) { return { ok: false, errors: [cause instanceof Error ? cause.message : String(cause)] }; }
  let value: unknown;
  try { value = JSON.parse(body); }
  catch (cause) { return { ok: false, errors: [`JSON 格式错误：${cause instanceof Error ? cause.message : String(cause)}`] }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["计划包必须是一个 JSON 对象"] };
  const version = (value as { packageVersion?: unknown }).packageVersion;
  if (version !== DIRECTOR_PLAN_PACKAGE_VERSION) return { ok: false, errors: [`packageVersion 应为 ${DIRECTOR_PLAN_PACKAGE_VERSION}，收到 ${JSON.stringify(version ?? null)}`] };
  const parsed = DirectorPlanPackageSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const where = issue.path.join(".") || "计划包";
        if (issue.code === "unrecognized_keys") return `${where}：不允许的字段 ${issue.keys.join("、")}（计划包只写导演语义；最终 H3 Prompt 由本地编译器生成）`;
        return `${where}：${issue.message}`;
      }),
    };
  }
  return { ok: true, pkg: parsed.data, canonical: JSON.stringify(parsed.data) };
}

/** Package → the pieces the M2 validator / compiler use (forbiddenTerms and forbiddenClaims are enforced alike). */
export function packageToDraft(pkg: DirectorPlanPackage) {
  const constraints = Object.fromEntries(DIRECTOR_CONSTRAINT_KEYS.map((key) => [key, pkg.constraints[key]])) as unknown as DirectorConstraints;
  const plan: DirectorPlan = { title: pkg.project.title, logline: pkg.plan.summary, style: pkg.plan.style, characters: pkg.plan.characters, shots: pkg.plan.shots };
  return {
    intent: pkg.project.brief, targetSeconds: pkg.project.targetDurationSeconds, aspect: pkg.project.aspectRatio, preset: pkg.project.preset, constraints,
    forbiddenTerms: pkg.constraints.forbiddenTerms, approvedFacts: pkg.approvedFacts, forbiddenClaims: pkg.forbiddenClaims,
    subjectAnchor: normalizeSubjectAnchor(pkg.subjectAnchor), plan,
  };
}

const sameList = (a: string[], b: string[]) => { const norm = (list: string[]) => [...new Set(list.map((item) => item.trim()).filter(Boolean))].sort(); return JSON.stringify(norm(a)) === JSON.stringify(norm(b)); };
const anchorKey = (anchor: SubjectAnchor | null | undefined) => JSON.stringify(normalizeSubjectAnchor(anchor ?? null));

/** Every request field the package changed compared with what the canvas asked for (either direction). */
export function packageRequestDifferences(pkg: DirectorPlanPackage, expected: DirectorPackageRequest): string[] {
  const out: string[] = [];
  if (pkg.project.brief.trim() !== expected.brief.trim()) out.push("project.brief（一句话需求）被改动了");
  if (pkg.project.targetDurationSeconds !== expected.targetDurationSeconds) out.push(`project.targetDurationSeconds：画布要求 ${expected.targetDurationSeconds}，计划包是 ${pkg.project.targetDurationSeconds}`);
  if (pkg.project.aspectRatio !== expected.aspectRatio) out.push(`project.aspectRatio：画布要求 ${expected.aspectRatio}，计划包是 ${pkg.project.aspectRatio}`);
  if (pkg.project.preset !== expected.preset) out.push(`project.preset：画布要求 ${expected.preset}，计划包是 ${pkg.project.preset}`);
  for (const key of DIRECTOR_CONSTRAINT_KEYS) if (pkg.constraints[key] !== expected.constraints[key]) out.push(`constraints.${key}：画布要求 ${expected.constraints[key]}，计划包是 ${pkg.constraints[key]}`);
  if (!sameList(pkg.constraints.forbiddenTerms, expected.constraints.forbiddenTerms)) out.push("constraints.forbiddenTerms（禁用词）被改动了");
  if (!sameList(pkg.approvedFacts, expected.approvedFacts)) out.push("approvedFacts（已批准事实）被改动了");
  if (!sameList(pkg.forbiddenClaims, expected.forbiddenClaims)) out.push("forbiddenClaims（禁止说法）被改动了");
  let packageAnchor: string;
  try { packageAnchor = anchorKey(pkg.subjectAnchor); } catch { packageAnchor = "invalid"; }
  if (packageAnchor !== anchorKey(expected.subjectAnchor)) out.push("subjectAnchor（主体锚点）被改动了");
  return out;
}

/** The request part of a package, pre-filled for the director to copy unchanged. */
export function packageSkeleton(request: DirectorPackageRequest) {
  const { forbiddenTerms, ...switches } = request.constraints;
  return {
    packageVersion: DIRECTOR_PLAN_PACKAGE_VERSION,
    project: { title: "<short title>", brief: request.brief, targetDurationSeconds: request.targetDurationSeconds, aspectRatio: request.aspectRatio, preset: request.preset },
    constraints: { ...switches, forbiddenTerms },
    subjectAnchor: request.subjectAnchor,
    approvedFacts: request.approvedFacts,
    forbiddenClaims: request.forbiddenClaims,
    plan: { summary: "<one sentence>", style: "<English style line>", characters: [], shots: [] },
  };
}

/** Rebuild a package from a frozen M2 plan (imported or locally planned) — for 【复制修改要求】. */
export function packageFromPlan(input: { plan: DirectorPlan; request: DirectorPackageRequest }) {
  const skeleton = packageSkeleton(input.request);
  return { ...skeleton, project: { ...skeleton.project, title: input.plan.title }, plan: { summary: input.plan.logline, style: input.plan.style, characters: input.plan.characters, shots: input.plan.shots } };
}

/** Natural-language revision request for the chat window: what to change + what the program found + the full package. */
export function buildRevisionRequest(packageJson: unknown, change: string, problems: string[]) {
  return [
    "请基于下面这份 Director Plan Package 修改导演计划。",
    change.trim() ? `修改要求：\n${change.trim()}` : "修改要求：请修正下面列出的程序检查问题，其他内容尽量保持不变。",
    ...(problems.length ? [`程序检查发现的问题：\n${problems.map((problem) => `- ${problem.replace(/\[[a-z_]+\]\s*/, "")}`).join("\n")}`] : []),
    "project、constraints、subjectAnchor、approvedFacts、forbiddenClaims 保持原样，不要改动。只填导演语义字段，不要写任何视频模型的提示词格式、标签或字段名。",
    "请返回完整的新版 Director Plan JSON（director-plan-package-v1）。只返回 Director Plan JSON，不要解释，不要Markdown代码围栏。",
    "",
    JSON.stringify(packageJson, null, 2),
  ].join("\n\n");
}

/** The request a frozen M2 job answers (imported or locally planned), in package form. */
export function requestFromM2(m2: {
  intent: string; targetSeconds: number; aspect: M2Aspect; preset?: M2PresetId; constraints?: DirectorConstraints; subjectAnchor?: SubjectAnchor | null;
  approvedFacts?: string[]; forbiddenClaims?: string[]; forbiddenTerms?: string[];
}): DirectorPackageRequest {
  const terms = m2.forbiddenTerms ?? [];
  return {
    brief: m2.intent, targetDurationSeconds: m2.targetSeconds, aspectRatio: m2.aspect, preset: m2.preset ?? "general",
    constraints: { ...(m2.constraints ?? { allowDialogue: true, allowReadableText: false, allowGeneratedUI: false, allowNumbers: false, allowVoiceover: true }), forbiddenTerms: terms },
    subjectAnchor: m2.subjectAnchor ?? null, approvedFacts: m2.approvedFacts ?? [],
    // Imported jobs store banned words merged into forbiddenClaims; split them back out.
    forbiddenClaims: (m2.forbiddenClaims ?? []).filter((claim) => !terms.includes(claim)),
  };
}
