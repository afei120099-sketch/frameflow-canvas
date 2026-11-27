/** Exact manifest validation emitted before createRun; never infer non-submission from an arbitrary error. */
export function missingPrimaryVoice(message: unknown): message is string {
  return typeof message==='string' && /^角色“[^”]+”没有可用主声音(?:；请在角色库设置主声音后再生成)?$/.test(message);
}
