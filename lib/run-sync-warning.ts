/** A deliberately paused clock is not a failed read. Only actual rejection enables this warning. */
export function runSyncWarning(lastSync: number, readFailed: boolean, now: number) {
  if (!readFailed) return null;
  if (!lastSync) return "数据读取失败，尚未成功同步生成记录";
  if (now - lastSync <= 10000) return null;
  return `数据读取失败，显示的是最后同步于 ${new Date(lastSync).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} 的值`;
}
