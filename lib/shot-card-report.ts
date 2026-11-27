/**
 * 镜头卡片「画布自己的检查」（h3q 查不到的那几项），给卡片和收件箱共用（收件箱把结果写进 *_status.json，别的 AI 读得到）。
 * 只读：不改队列、不建节点、不碰 GPU。
 */
import type { AssetRecord } from "./production-records.ts";
import type { RoleRecord } from "./role-records.ts";
import { getActualDuration } from "./comfyui/h3-parameters.ts";
import { breakdownShotPrompt, type ClauseOverrides } from "./shot-card-breakdown.ts";
import { checkShot, type ShotCheck } from "./shot-card-checks.ts";
import { planShotReferences, type ShotQueue, type ShotQueueShot } from "./shot-queue.ts";
import { GATE_LABEL, queueGate, shotGate } from "./shot-gate.ts";
import { OPENING_GAP_FIXES, OPENING_GAP_ID, OPENING_GAP_LABEL, OPENING_GAP_RULE } from "./opening-gap.ts";

/** Picture numbers as the prompt writes them: frames take no number; the canvas shifts the rest at submit time (prepareKeyframeSubmission). */
export const picturesAsWritten = (pictures: readonly { label: string; name: string }[]) =>
  pictures.filter((picture) => !/^(?:首帧|尾帧) /.test(picture.name)).map((picture, i) => ({ ...picture, label: `Picture ${i + 1}` }));

/** Roles of one shot as the checks see them (name, bindings, who speaks). */
export function checkRolesOf(shot: ShotQueueShot, roles: readonly RoleRecord[], assets: ReadonlyMap<string, AssetRecord>) {
  const speakers = new Set([...(shot.dialogue ?? []).flatMap((line) => line.roleId ? [line.roleId] : []), ...(shot.voiceRoleId ? [shot.voiceRoleId] : []), ...(shot.voiceRoleIds ?? [])]);
  return shot.roleIds.map((roleId) => {
    const role = roles.find((item) => item.roleId === roleId);
    const voice = role?.primaryVoiceAssetId ? assets.get(role.primaryVoiceAssetId) : undefined;
    return {
      ...(shot.voiceRoleIds?.length ? { voiceListed: shot.voiceRoleIds.includes(roleId), voiceSeconds: typeof voice?.duration === "number" && Number.isFinite(voice.duration) ? voice.duration : null } : {}),
      roleId, name: role?.displayName ?? roleId, offscreen: Boolean(shot.offscreenRoleIds?.includes(roleId)), speaks: speakers.has(roleId), missing: !role,
      hasAppearance: Boolean(role?.primaryAppearanceAssetId && assets.get(role.primaryAppearanceAssetId)),
      hasVoice: Boolean(role?.primaryVoiceAssetId && assets.get(role.primaryVoiceAssetId)),
    };
  });
}

/** All checks for one shot, exactly what its card shows. */
export function shotCardChecks(shot: ShotQueueShot, queue: Pick<ShotQueue, "defaults">, roles: readonly RoleRecord[], assets: ReadonlyMap<string, AssetRecord>, overrides: ClauseOverrides = {}): ShotCheck[] {
  const checkRoles = checkRolesOf(shot, roles, assets);
  let pictures: { label: string; name: string }[] = [];
  let refError = "";
  // 正本：首帧 / 尾帧不占 Picture 编号。The plan lists pictures after the submit-time shift (frames first),
  // so compare the prompt against the order without frames.
  try { pictures = picturesAsWritten(planShotReferences(shot, roles as RoleRecord[], assets as Map<string, AssetRecord>).pictures); }
  catch (cause) { refError = cause instanceof Error ? cause.message : "参考图核对失败"; }
  const fieldLines: Record<string, string[]> = {};
  for (const line of shot.dialogue ?? []) {
    const name = line.roleId ? checkRoles.find((role) => role.roleId === line.roleId)?.name ?? line.roleId : line.speaker ?? "";
    (fieldLines[name] ??= []).push(line.text);
  }
  return [
    ...(refError && !checkRoles.some((role) => role.missing) ? [{ code: "picture_plan", level: "error" as const, message: `参考图排不出来：${refError}` }] : []),
    ...checkShot({
      prompt: shot.prompt, breakdown: breakdownShotPrompt(shot.prompt, overrides), actualSeconds: getActualDuration(shot.seconds).actualSeconds, requestedSeconds: shot.seconds,
      soundMode: shot.soundMode, pictures, roles: checkRoles, fieldLines, autoVoiceDisabled: shot.autoVoiceDisabled, noBackgroundMusic: Boolean(queue.defaults?.noBackgroundMusic),
      ...(shot.voiceRoleIds?.length ? { voiceRoles: true } : {}),
    }),
    // 画面五项·必写：漏写算写错（红），这一镜不能入队（lib/shot-gate.ts）。
    ...shotGate(shot).map((item) => ({ code: `gate:${item.id}`, level: "error" as const, message: item.id === OPENING_GAP_ID
      ? `${OPENING_GAP_LABEL}：${item.note}。${OPENING_GAP_RULE}，不改不能入队；${OPENING_GAP_FIXES}（画布判定；正本 h3q 能跑时以 h3q 的 [开场空白] 为准）`
      : `${GATE_LABEL}·${item.label}漏写：${item.note}。不写全不能入队（画布判定；正本 h3q 能跑时以 h3q 的 [五项·${item.label}] 为准）` })),
  ];
}

export interface CardCheckReport {
  /** 写错的镜数 / 只有漏写的镜数 / 全过的镜数 */
  errorShots: number; warnShots: number; okShots: number;
  shots: { chapter: number; index: number; title: string; errors: string[]; warnings: string[] }[];
  /** 画面五项不过的镜头：有一镜不过，收件箱整批不提交。 */
  gate: { ok: boolean; message: string; /** h3q = 正本 h3q 判的；canvas = 画布完整度判的（收件箱提交前会用 h3q 结果覆盖） */ source?: "h3q" | "canvas"; failures: { title: string; missing: string[] }[] };
  note: string;
}

/** Whole-queue report for another AI: per shot its title, red (写错) and yellow (漏写) messages. */
export function queueCardReport(queue: ShotQueue, roles: readonly RoleRecord[], assets: readonly AssetRecord[]): CardCheckReport {
  const byId = new Map(assets.filter((asset) => !asset.recycled).map((asset) => [asset.assetId, asset]));
  const shots = queue.chapters.flatMap((chapter, c) => chapter.shots.map((shot, s) => {
    const checks = shotCardChecks(shot, queue, roles, byId);
    return { chapter: c + 1, index: s + 1, title: shot.title, errors: checks.filter((check) => check.level === "error").map((check) => check.message), warnings: checks.filter((check) => check.level === "warn").map((check) => check.message) };
  }));
  return {
    errorShots: shots.filter((shot) => shot.errors.length).length,
    warnShots: shots.filter((shot) => !shot.errors.length && shot.warnings.length).length,
    okShots: shots.filter((shot) => !shot.errors.length && !shot.warnings.length).length,
    shots,
    gate: (() => { const gate = queueGate(queue); return { ok: gate.ok, message: gate.message, source: gate.source, failures: gate.failures.map((failure) => ({ title: failure.title, missing: failure.items.map((item) => item.label) })) }; })(),
    note: "画面五项（风格胶片、光线、景别焦段、构图、运镜机位）任何一项漏写，这一镜算写错，整批不提交、不入队（gate）。镜头卡片「画布自己的检查」：参考图顺序 / 数量、时间轴、角色绑定、对白说话人、每段有动作、声音。errors 是写错（先改），warnings 是漏写（建议补）。写法规则（dialogue 留空、人名、嘴、配乐、景别、光线……）不在这里，请自己跑正本 python -I %FRAMEFLOW_H3_TOOLS%\\h3q.py check <队列.json>，以正本 %FRAMEFLOW_H3_TOOLS%\\SKILL_h3-video.md 为准。只改有问题的镜头，title 一字不改。用户在卡片里点「这镜不用」忽略的条目这里不知道，仍会列出。",
  };
}
