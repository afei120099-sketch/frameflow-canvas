import { findMediaReferences, type H3MediaCounts } from './h3-preflight.ts';
import { secondsToH3Length } from './comfyui/h3-parameters.ts';
import { parseDialogueRow } from './dialogue-row.ts';
import { isOfficialFormat } from './official-format.ts';
import { officialSubjectLimit } from './h3-preflight.ts';

/** Only explicitly marked speech is counted; quoted signs are not guessed to be dialogue. */
export function extractDialogue(prompt: string, structured: {text: string}[] = []) {
  const tagged = [...prompt.matchAll(/<d\b[^>]*>([\s\S]*?)<\/d>/gi)].map(match => match[1].replace(/^\s*\[[^\]]+\]\s*/, '').trim()).filter(Boolean);
  // 正本「第一集写法」: 对白（中文普通话，口型同步）：张三：“……” 李四：“……”
  const row = parseDialogueRow(prompt).entries.map(entry => entry.text);
  const labeled = tagged.length ? tagged : row.length ? row : [...prompt.matchAll(/(?:台词|对白|旁白|画外音|dialogue|narration)\s*[:：]\s*[“"]([^”"\n]+)[”"]/gi)].map(match => match[1].trim());
  // Structured lines really are appended to raw prompt; do not silently de-duplicate repeated speech.
  return [...labeled, ...structured.map(line => line.text.trim()).filter(Boolean)];
}

/** Scene text sitting next to Picture 1. Keyframe shots submit that slot as the frame. */
export function sceneWrittenAsPicture1(prompt: string) {
  const scene = /场景|地点|\bscene\b|\blocation\b/i;
  for (const match of prompt.matchAll(/(?:<\s*)?Picture\s*1\b\s*>?/gi)) {
    const at = match.index ?? 0;
    if (scene.test(prompt.slice(Math.max(0, at - 80), Math.min(prompt.length, at + match[0].length + 80)))) return true;
  }
  return false;
}

export function promptTagErrors(prompt: string, counts: H3MediaCounts, layout?: { frames?: number }) {
  const errors: string[] = [];
  for (const tag of prompt.matchAll(/<\s*(?:Subject|Picture|Image|Audio|Video)[^>]*(?:>|$)/gi)) {
    if (!/^<(?:Subject|Picture|Image|Audio|Video) [1-9]\d*>$/.test(tag[0])) errors.push(`引用写法不合法：${tag[0]}；请用 <Subject 1>、<Picture 1>、<Audio 1> 等从 1 开始的写法`);
  }
  for (const ref of findMediaReferences(prompt).filter(ref => ref.style === 'tag')) {
    const limit = ref.kind === 'subject' ? Math.max(officialSubjectLimit(prompt) ?? 0, counts.subjects) : ref.kind === 'picture' ? counts.pictures : ref.kind === 'audio' ? counts.audios : counts.videos;
    if (ref.ordinal < 1 || ref.ordinal > limit) errors.push(`引用 ${ref.text} 不存在，当前仅有 ${limit} 个 ${ref.kind}`);
  }
  if ((layout?.frames ?? 0) > 0 && sceneWrittenAsPicture1(prompt)) errors.push(`有首帧或尾帧时，提交顺序里 Picture 1 是关键帧，场景图不应写成 Picture 1`);
  if ((prompt.match(/<d(?:\s[^>]*)?>/gi) ?? []).length !== (prompt.match(/<\/d>/gi) ?? []).length) errors.push('对白 <d> 与 </d> 标签不成对');
  return [...new Set(errors)];
}

/** Heuristics, not tokenizer or phoneme guarantees. Never truncate or rewrite user text. */
export function shotPromptWarnings(prompt: string, seconds: number, structured: {text: string}[] = []) {
  const warnings: string[] = [];
  const lines = extractDialogue(prompt, structured);
  const text = lines.join(' ');
  const chinese = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const words = (text.replace(/\p{Script=Han}/gu, '').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const units = chinese + words * 2;
  if (units && seconds > 0) {
    const rate = units / seconds;
    if (rate > 6) warnings.push(`对白可能过快：${chinese} 个汉字 / ${words} 个外语词，约 ${rate.toFixed(1)} 字当量/秒（按整镜 ${seconds.toFixed(1)} 秒估算）；对白只占部分时间时会更快`);
    // 官方格式没有时间段，整镜平均语速说明不了留白（正本 v2026-11-13 不管开场空白），只提示过快。
    else if (rate < 1.5 && !isOfficialFormat(prompt)) warnings.push(`对白可能偏慢或留白较长：约 ${rate.toFixed(1)} 字当量/秒（按整镜时长估算；有停顿可忽略）`);
  }
  if (!lines.length && (parseDialogueRow(prompt).found || /<d\b|旁白|画外音|\bsays?\b|\bnarration\b/i.test(prompt))) warnings.push('未识别出可统计台词：台词写在正文「对白（中文普通话，口型同步）：张三：“……”」这一行；未识别不等于没有对白');
  return warnings;
}

export function durationAlignmentWarning(seconds: number) {
  const actual = secondsToH3Length(seconds) / 24;
  return Math.abs(actual-seconds) > .05 ? `请求 ${seconds} 秒，H3 帧数对齐后约 ${actual.toFixed(2)} 秒（17n+5 帧）` : null;
}

export function shotListCsv(shots: {title: string; seconds: number; prompt: string; dialogue?: {text:string}[]}[]) {
  const cell = (value: string | number) => {
    const text = String(value);
    // Spreadsheet formula injection must remain inert, including user-authored titles/dialogue.
    return '"'+(/^[\s]*[=+@-]/.test(text) ? "'"+text : text).replace(/"/g,'""')+'"';
  };
  return '\uFEFF'+[['镜头名称','请求时长（秒）','H3对齐时长（秒）','台词清单','台词提取状态'],...shots.map(shot => {
    const lines = extractDialogue(shot.prompt,shot.dialogue);
    return [shot.title,shot.seconds,(secondsToH3Length(shot.seconds)/24).toFixed(2),lines.join('\n'),lines.length?'已提取':'未识别（不代表无对白）'];
  })].map(row=>row.map(cell).join(',')).join('\r\n');
}
