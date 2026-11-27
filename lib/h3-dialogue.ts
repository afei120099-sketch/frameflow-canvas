/** Internal node representation: empty roleId explicitly means an unbound speaker. */
export interface H3DialogueLine { roleId: string; text: string; speaker?: string; voice?: string }
/** Asset-reference namespace, distinct from local video's media: storage prefix. */
export const DIALOGUE_AUDIO_PREFIX = "audio:";
export function parseH3Dialogue(value: unknown, roleIds: readonly string[], where: string): H3DialogueLine[] {
  // JSON null and an omitted field both explicitly represent no dialogue.
  const dialogue = value ?? [];
  if (!Array.isArray(dialogue) || dialogue.length > 100) throw Error(where+' 必须是最多100句的 dialogue 数组');
  const errors: string[] = [];
  const parsed: H3DialogueLine[] = [];
  dialogue.forEach((entry, index) => {
    const at=where+` 第${index+1}句`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(at+' 格式错误'); return; }
    const line=entry as Record<string,unknown>;
    if (typeof line.text!=='string' || !line.text.trim() || line.text.length>12000) errors.push(at+' text 需要非空台词，最多12000字符');
    if (line.roleId !== undefined && line.roleId !== '') {
      if(typeof line.roleId!=='string'||!roleIds.includes(line.roleId.trim())) errors.push(at+' roleId 必须是本镜头绑定角色');
      if(line.voice!==undefined||line.speaker!==undefined) errors.push(at+' roleId 与 speaker/voice 不能混用');
      if(typeof line.roleId==='string'&&typeof line.text==='string')parsed.push({roleId:line.roleId.trim(),text:line.text.trim()});
      return;
    }
    if(typeof line.speaker!=='string'||!line.speaker.trim()||line.speaker.length>80) errors.push(at+' 无 roleId 时必须填写 speaker 名称（最多80字符）');
    const voice=line.voice??'none';
    if(typeof voice!=='string'||(voice!=='none'&&!/^audio:[^\s:]+$/.test(voice))) errors.push(at+' voice 只能为 none 或 audio:声音素材ID');
    if(typeof line.speaker==='string'&&typeof line.text==='string'&&typeof voice==='string')parsed.push({roleId:'',speaker:line.speaker.trim(),voice,text:line.text.trim()});
  });
  if(errors.length)throw Error(errors.join('\n'));
  return parsed;
}
export function dialogueAudioIds(dialogue: readonly H3DialogueLine[] = []) {
  return [...new Set(dialogue.filter(line=>!line.roleId&&line.voice?.startsWith(DIALOGUE_AUDIO_PREFIX)).map(line=>line.voice!.slice(DIALOGUE_AUDIO_PREFIX.length)))];
}
