import { compileH3Prompt, NO_MUSIC_MARKER, NO_MUSIC_MARKER_WITH_LINES, type H3SoundMode } from "./comfyui/h3-prompt.ts";
import type { ReferenceManifest, DialogueEntry } from "./reference-manifest.ts";
import { appendVoiceReference } from "./voice-roles.ts";
import { isOfficialFormat, OFFICIAL_SUBMIT_NOTE, OFFICIAL_VOICE_NOTE } from "./official-format.ts";

/**
 * H3 Prompt Compiler V1.
 *
 * Layer A (semantic input) is what the user asked for. Layer B compiles it deterministically.
 * FL2VA and Ref2VA are compiled separately; FL2VA keeps the verified plain behaviour.
 *
 * Ref2VA "official_structured" follows MiniMax's full-reference guide (ref-en.txt): six sections
 * subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape /
 * non_diegetic_music, <Subject N> / <Picture N> / <Audio N> labels, speaker IDs (Sx) in vocal order
 * and <d>[Language] ...</d> dialogue. It is experimental: not yet human-verified on the local
 * INT8 + Turbo workflow. "plain" submits the user's text as written (正本「第一集写法」: lines live in the
 * prompt's 对白 row, `dialogue` stays empty). Old queues with a `dialogue` list still get the role bindings appended.
 */

export type H3PromptMode = "plain" | "official_structured";
export const H3_PROMPT_COMPILER_VERSION = "h3-prompt-compiler-v1.3";
export const PLAIN_DIALOGUE_NOTE = "已编译角色台词及声音绑定；对白效果待真人试听，不保证逐字准确";
export const LEGACY_DIALOGUE_NOTE = "dialogue 字段不是空的：正本要求留空、台词写进正文「对白（中文普通话，口型同步）：」行；用卡片里的一键按钮搬过去";
export const VOICE_ROLES_NOTE = "🧪 voiceRoleIds：已送说话角色主声音（提交时截前几秒），参考说明末尾加了声音说明；未试渲";
export const OFFICIAL_MODE_WARNING = "实验｜尚未在当前 INT8 + Turbo 工作流真人验证";
export const ENGLISH_NOTE = "当前镜头描述未按官方建议自动英文化";

/** Layer A: user intent. No Picture/Audio numbers appear here. */
export interface H3SemanticInput {
  rawPrompt: string;
  soundMode: H3SoundMode;
  roleIds: string[];
  dialogue: { roleId: string; text: string }[];
  shotId?: string | null;
}

export interface CompiledH3Prompt { mode: H3PromptMode; prompt: string; notes: string[]; compilerVersion: string }

export function compileH3Fl2vaPrompt(input: Pick<H3SemanticInput, "rawPrompt" | "soundMode">): CompiledH3Prompt {
  return { mode: "plain", prompt: compileH3Prompt(input.rawPrompt, input.soundMode), notes: [], compilerVersion: H3_PROMPT_COMPILER_VERSION };
}

const HAN = /[㐀-鿿]/;
export function dialogueLanguage(text: string) {
  if (/[぀-ヿ가-힯]/.test(text)) throw new Error("第一版官方结构模式只支持中文或英文台词");
  if (HAN.test(text)) return "Chinese";
  if (/[A-Za-z]/.test(text)) return "English";
  throw new Error("无法确定台词语言：第一版官方结构模式只支持中文或英文台词");
}

const sentence = (text: string) => { const value = text.trim().replace(/\s+/g, " "); return /[.!?。！？]$/.test(value) ? value : `${value}.`; };
const joinLabels = (labels: string[]) => labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;

function guestLine(line: DialogueEntry, manifest: ReferenceManifest) {
  const audio=line.audioRefIndex ? manifest.audioRefs.find(ref=>ref.index===line.audioRefIndex) : null;
  if(line.audioRefIndex && !audio) throw Error(`第${line.order}句声音素材绑定缺失`);
  return `${line.order}. ${JSON.stringify(line.speaker)} (${line.speakerId}), an unbound speaker described in the shot prompt, says: ${JSON.stringify(line.text)}. ${audio ? `Use ${audio.label} only as this speaker's voice-timbre reference.` : 'No reference voice is assigned; generate a distinct voice consistent with this speaker described in the shot prompt.'} Do not use any bound character's face, identity, or voice for this speaker. Do not apply this voice to other speakers.`;
}

export function compileH3Ref2vaPrompt(input: { rawPrompt: string; soundMode: H3SoundMode; mode: H3PromptMode; manifest: ReferenceManifest }): CompiledH3Prompt {
  const rawPrompt = input.rawPrompt.trim();
  if (input.mode === "plain") {
    // 官方 Ref2VA 六段式：正文原样提交，不加画外音句、声音绑定、台词追加段（声音不送：lib/h3-speaker-policy.ts）。
    if (isOfficialFormat(rawPrompt)) {
      // 写了 voiceRoleIds：声音照顺序送（manifest 已排好 <Audio 1>…，提交时截前 8 秒），正文仍一字不改。
      const voices = input.manifest.voiceRoleIds?.length ?? 0;
      if (voices && input.soundMode !== "av") throw new Error("角色主声音需要“视听生成”模式");
      return { mode: "plain", prompt: rawPrompt, notes: [OFFICIAL_SUBMIT_NOTE, ...(voices ? [OFFICIAL_VOICE_NOTE(voices)] : [])], compilerVersion: H3_PROMPT_COMPILER_VERSION };
    }
    const offscreen = input.manifest.roleBindings.filter(role => role.offscreen);
    const offscreenRule = offscreen.map(role => `${role.subjectAlias} (${role.roleName}) is an off-screen voice only, never visible in the frame. No on-screen person speaks or lip-syncs this role's lines. Do not depict this role's face or body.`).join("\n");
    const base = [compileH3Prompt(rawPrompt, input.soundMode), offscreenRule].filter(Boolean).join("\n\n");
    // 🧪 plain 声音路（voiceRoleIds）：只在参考说明那一句末尾加「<Audio N>是X的声音，只用于X说话的音色」，别的一个字不加。
    if (input.manifest.voiceRoleIds?.length) {
      if (input.soundMode !== "av") throw new Error("角色主声音需要“视听生成”模式");
      const voices = input.manifest.voiceRoleIds.map((roleId) => {
        const role = input.manifest.roleBindings.find((item) => item.roleId === roleId);
        const audio = role ? input.manifest.audioRefs.find((ref) => ref.index === role.audioRefIndex && ref.assetId === role.selectedVoiceAssetId) : null;
        if (!role || !audio) throw new Error("voiceRoleIds 里有说话角色的主声音绑定缺失，请在角色库重新指定主声音");
        return { label: audio.label, name: role.roleName };
      });
      return { mode: "plain", prompt: appendVoiceReference(base, voices), notes: [VOICE_ROLES_NOTE], compilerVersion: H3_PROMPT_COMPILER_VERSION };
    }
    const voiceRole = input.manifest.voiceRoleId ?input.manifest.roleBindings.find(role => role.roleId === input.manifest.voiceRoleId) : null;
    const voiceAudio = voiceRole ? input.manifest.audioRefs.find(audio => audio.index === voiceRole.audioRefIndex && audio.assetId === voiceRole.selectedVoiceAssetId) : null;
    if (input.manifest.voiceRoleId && (!voiceRole || !voiceAudio)) throw new Error("指定说话角色的主声音绑定缺失，请重新选择主声音");
    if (voiceRole && input.soundMode !== "av") throw new Error("角色主声音需要“视听生成”模式");
    const voiceBinding = voiceRole && voiceAudio ? `${voiceAudio.label}: reference - use this audio only as the voice-timbre reference for ${voiceRole.subjectAlias} (${voiceRole.roleName}, ${voiceRole.offscreen ? "off-screen voice only" : `identity reference <Picture ${voiceRole.pictureRefIndex}>`}). Apply it to that subject's speech or off-screen narration already specified above. Keep the original words, language, timing, delivery and on-screen/off-screen placement. Do not copy words from the reference recording or add new speech.` : "";
    if (!input.manifest.dialogue.length) return { mode: "plain", prompt: voiceBinding ? `${base}\n\nVoice-timbre binding:\n${voiceBinding}` : base, notes: voiceBinding ? ["已编译角色主声音绑定；台词与时间沿用原提示词，音色效果待试听"] : [], compilerVersion: H3_PROMPT_COMPILER_VERSION };
    if (input.soundMode !== "av") throw new Error("角色台词需要“视听生成”模式");
    const bindings = input.manifest.roleBindings;
    const definitions = bindings.map((binding) => {
      if (binding.offscreen) return `${binding.subjectAlias} is ${binding.roleName}, an off-screen voice only, never shown.`;
      const picture = input.manifest.pictureRefs.find((ref) => ref.index === binding.pictureRefIndex);
      if (!picture) throw new Error(`角色“${binding.roleName}”的参考图绑定缺失`);
      return `${binding.subjectAlias} is ${binding.roleName} in ${picture.label}${binding.description.trim() ? `, ${binding.description.trim()}` : ""}.`;
    });
    const lines = input.manifest.dialogue.map((line) => {
      if (!line.roleId) return guestLine(line, input.manifest);
      const binding = bindings.find((item) => item.roleId === line.roleId);
      const speaker = input.manifest.speakers.find((item) => item.speakerId === line.speakerId && item.roleId === line.roleId);
      if (!binding || !speaker) throw new Error("角色台词的说话者绑定缺失，请重新选择说话角色");
      const audio = input.manifest.audioRefs.find((ref) => ref.index === speaker.audioRefIndex);
      if (speaker.audioRefIndex !== null && !audio) throw new Error(`角色“${binding.roleName}”的声音绑定缺失`);
      const language = /[㐀-鿿]/.test(line.text) ? " in Mandarin Chinese" : "";
      return `${line.order}. ${binding.subjectAlias} (${binding.roleName}, ${speaker.speakerId}) ${binding.offscreen ? "narrates off-screen" : "says"}${language}${audio ? `, using ${audio.label} only as the voice-timbre reference` : ""}: ${JSON.stringify(line.text)}`;
    });
    // Old queues only: 正本「第一集写法」 keeps `dialogue` empty (card check reports it red, with a one-click move
    // into the 对白 row). Nothing is added for roles without lines and no meta sentence about the list (both get spoken).
    const dialogue = [
      "Role appearance and voice bindings for this shot:", ...definitions,
      "Spoken dialogue, in playback order:",
      ...lines,
      ...(voiceBinding ? [voiceBinding] : []),
    ].join("\n");
    const audible = base.replace(NO_MUSIC_MARKER, NO_MUSIC_MARKER_WITH_LINES);
    return { mode: "plain", prompt: `${audible}\n\n${dialogue}`, notes: [PLAIN_DIALOGUE_NOTE, LEGACY_DIALOGUE_NOTE], compilerVersion: H3_PROMPT_COMPILER_VERSION };
  }
  const manifest = input.manifest;
  if (manifest.dialogue.some(line=>!line.roleId)) throw Error('无绑定角色说话者目前请使用普通 Prompt 模式；官方结构模式暂不支持');
  if (!manifest.roleBindings.length) throw new Error("官方结构模式至少需要加入一个角色");
  if (manifest.videoRefs.length) throw new Error("官方结构模式第一版暂不支持参考视频；请移除参考视频或改用普通 Prompt");
  const unboundPictures = manifest.pictureRefs.filter((ref) => !ref.roleIds.length);
  if (unboundPictures.length) throw new Error(`官方结构模式下参考图 ${unboundPictures.map((ref) => `${ref.label}“${ref.filename}”`).join("、")} 未绑定角色；请把它加入对应角色，或移除后重试`);
  const unboundAudios = manifest.audioRefs.filter((ref) => !manifest.speakers.some((speaker) => speaker.audioRefIndex === ref.index));
  if (unboundAudios.length) throw new Error(`官方结构模式下参考声音 ${unboundAudios.map((ref) => `${ref.label}“${ref.filename}”`).join("、")} 没有对应的说话角色；不说话的角色不提交声音`);

  const bindings = [...manifest.roleBindings].sort((a, b) => a.subjectIndex - b.subjectIndex);
  const subject = (roleId: string) => bindings.find((binding) => binding.roleId === roleId)!;
  const picture = (index: number | null) => index === null ? "" : manifest.pictureRefs[index - 1].label;
  const audio = (index: number) => manifest.audioRefs[index - 1].label;
  const speakers = manifest.speakers;
  const hasVoice = speakers.some((speaker) => speaker.audioRefIndex !== null);

  const subjectLines = bindings.map((binding) => binding.offscreen ? `${binding.subjectAlias} is ${binding.roleName}, an off-screen narrator with no visible face or body.` : `${binding.subjectAlias} is ${binding.roleName} in ${picture(binding.pictureRefIndex)}${binding.description.trim() ? `, ${binding.description.trim().replace(/[.。]$/, "")}` : ""}.`);
  const audioLines = speakers.filter((speaker) => speaker.audioRefIndex !== null).sort((a, b) => a.audioRefIndex! - b.audioRefIndex!).map((speaker) => `${audio(speaker.audioRefIndex!)} is the voice-timbre reference for ${subject(speaker.roleId).subjectAlias} (${speaker.speakerId}).`);

  const taskTypes = ["reference generation", ...(hasVoice ? ["audio reference"] : [])].join(" + ");
  const voiceSummary = speakers.filter((speaker) => speaker.audioRefIndex !== null).map((speaker) => ` ${audio(speaker.audioRefIndex!)} is used as the voice-timbre reference for ${subject(speaker.roleId).subjectAlias}.`).join("");
  const visible = bindings.filter(binding => !binding.offscreen);
  const summary = `[${taskTypes}] ${visible.length ? `The target video features ${joinLabels(visible.map(binding => binding.subjectAlias))}.` : "The target video uses off-screen narration; no narrator is visible."}${voiceSummary}`;

  const retention = [
    ...bindings.filter(binding => !binding.offscreen).map((binding) => `${binding.subjectAlias} (appears in [Shot 1]): fully_preserved - the appearance of ${binding.subjectAlias} from ${picture(binding.pictureRefIndex)} is retained.`),
    ...speakers.filter((speaker) => speaker.audioRefIndex !== null).sort((a, b) => a.audioRefIndex! - b.audioRefIndex!).map((speaker) => `${audio(speaker.audioRefIndex!)}: reference - the dialogue of ${subject(speaker.roleId).subjectAlias} follows the voice timbre of ${audio(speaker.audioRefIndex!)} without copying the original signal.`),
  ];

  const dialogueLines = manifest.dialogue.map((line) => {
    const speaker = speakers.find((item) => item.speakerId === line.speakerId)!;
    const voice = speaker.audioRefIndex !== null ? ` in the voice timbre referenced from ${audio(speaker.audioRefIndex)},` : "";
    return `${subject(line.roleId).subjectAlias} (${line.speakerId}) ${subject(line.roleId).offscreen ? "narrates off-screen" : "says"},${voice} <d>[${dialogueLanguage(line.text)}] ${line.text}</d>`;
  });
  const detailed = [`[Shot 1] ${rawPrompt ? sentence(rawPrompt) : ""}`.trimEnd(), ...dialogueLines].join("\n");

  const soundscape = input.soundMode === "silent" ? "N/A"
    : input.soundMode === "ambient" ? "Only room tone and action sounds synchronized with the visuals are audible."
    : "Natural ambient sounds and action sounds synchronized with the visuals.";

  const prompt = [
    `subject_definitions:\n${[...subjectLines, ...audioLines].join("\n")}`,
    `summary:\n${summary}`,
    `retention_analysis:\n${retention.join("\n")}`,
    `detailed_description:\n${detailed}`,
    `overall_soundscape:\n${soundscape}`,
    "non_diegetic_music:\nN/A",
  ].join("\n\n");

  const notes = [OFFICIAL_MODE_WARNING];
  if (HAN.test(rawPrompt) || bindings.some((binding) => HAN.test(binding.description))) notes.push(ENGLISH_NOTE);
  return { mode: "official_structured", prompt, notes, compilerVersion: H3_PROMPT_COMPILER_VERSION };
}
