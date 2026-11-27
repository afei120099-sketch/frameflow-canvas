import { voiceRoleIdsProblems } from './voice-roles.ts';
import { isOfficialFormat } from './official-format.ts';
export const AUTO_VOICE_KEY = 'frameflow-auto-dialogue-primary-voice';
export const AUTO_VOICE_EVENT = 'frameflow-auto-voice-change';
export function readAutoVoicePreference(): boolean {
  if (typeof window === 'undefined') return true;
  try { return window.localStorage.getItem(AUTO_VOICE_KEY) !== 'false'; } catch { return true; }
}
export function hasPromptDialogue(prompt: string): boolean {
  return [...prompt.matchAll(/<d\b[^>]*>([\s\S]*?)<\/d>/gi)].some(match => match[1].replace(/^\s*\[[^\]]+\]\s*/, '').trim().length > 0);
}
export interface SpeakerSelection {
  prompt: string; roleIds: readonly string[]; voiceRoleId?: string;
  /** 🧪 plain 声音路：说话角色按对白行第一次开口的顺序，每人送主声音（lib/voice-roles.ts）。 */
  voiceRoleIds?: readonly string[];
  autoVoiceDisabled?: boolean; autoVoiceEnabled?: boolean;
  dialogue?: readonly {roleId: string; text: string}[]; soundMode?: string;
}
/** Explicit opt-out is distinct from an accidentally missing speaker. No uploads or mutations. */
export interface SpeakerPolicy { hasDialogue: boolean; disabled: boolean; voiceRoleId: string | undefined; voiceRoleIds?: string[]; automatic: boolean; /** 官方格式：正文原样提交；只有写了 voiceRoleIds 才送声音 */ official?: boolean; errors: string[] }
export function resolveH3Speaker(input: SpeakerSelection): SpeakerPolicy {
  const hasDialogue = hasPromptDialogue(input.prompt) || Boolean(input.dialogue?.some(line => line.text.trim()));
  // 官方格式（正本 v2026-11-13）：正文原样提交，不自动选说话角色，不送 voiceRoleId。
  // 默认不送声音；队列写了 voiceRoleIds 才按顺序送（截前 8 秒，<Audio 1>…由写队列的人写在正文里）。
  // 人数和正文 <Audio N> 对不对得上在卡片画面检查里拦（lib/official-format.ts officialVoiceProblem），这里不报，免得整份队列载不进来。
  if (isOfficialFormat(input.prompt)) {
    const errors = hasDialogue && input.soundMode && input.soundMode !== 'av' ? ['有台词的镜头必须使用视听生成（av），不能使用静音或仅环境音'] : [];
    const voiceRoleIds = input.voiceRoleIds?.length ? [...input.voiceRoleIds] : undefined;
    if (voiceRoleIds) errors.push(...voiceRoleIdsProblems({ voiceRoleIds, roleIds: input.roleIds, voiceRoleId: input.voiceRoleId || undefined, structured: Boolean(input.dialogue?.length), disabled: input.autoVoiceDisabled === true, soundMode: input.soundMode }));
    return {hasDialogue, disabled: !voiceRoleIds, voiceRoleId: undefined, ...(voiceRoleIds ? { voiceRoleIds } : {}), automatic: false, official: true, errors};
  }
  const disabled = input.autoVoiceDisabled === true;
  const explicit = input.voiceRoleId || undefined;
  // Structured dialogue is authoritative per line: never fall back to the host for guests.
  const structured = Boolean(input.dialogue?.length);
  const voiceRoleIds = input.voiceRoleIds?.length ? [...input.voiceRoleIds] : undefined;
  // voiceRoleIds 列了说话人：不再自动带 roleIds[0] 的声音，也不和旧的两种写法混用。
  const voiceRoleId = disabled || structured || voiceRoleIds ? undefined : explicit || (hasDialogue && input.autoVoiceEnabled !== false ? input.roleIds[0] : undefined);
  const errors: string[] = [];
  if (voiceRoleIds) errors.push(...voiceRoleIdsProblems({ voiceRoleIds, roleIds: input.roleIds, voiceRoleId: explicit, structured, disabled, soundMode: input.soundMode }));
  if (!disabled && hasDialogue && !structured && !voiceRoleId && !voiceRoleIds) errors.push('提示词有台词但没有说话角色：请绑定角色并选择说话角色，或明确关闭本节点角色主声音');
  if (voiceRoleId && !input.roleIds.includes(voiceRoleId)) errors.push('说话角色 voiceRoleId 未绑定到本节点，请重新选择');
  if (hasDialogue && input.soundMode && input.soundMode !== 'av') errors.push('有台词的镜头必须使用视听生成（av），不能使用静音或仅环境音');
  return {hasDialogue, disabled, voiceRoleId, ...(voiceRoleIds && !disabled ? {voiceRoleIds} : {}), automatic: Boolean(voiceRoleId && !explicit && !structured), errors};
}
