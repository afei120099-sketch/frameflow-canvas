/**
 * 正本 h3q check 的输出（`python -I h3q.py check <队列> --all [--skip-table]`）按镜头拆开，给镜头卡片显示。
 * 规则只认 h3q 一处：这里只解析文字，不自己判断对错。h3q 没跑成时卡片要明说，不能当作通过。
 */
export type H3qLevel = "ERROR" | "WARN" | "HINT";
export interface H3qItem { level: H3qLevel; where: string; message: string }
export interface H3qReport {
  counts: Record<H3qLevel, number>;
  /** Per shot in queue order (chapters flattened, the way h3q numbers 镜1, 镜2 …). */
  shots: H3qItem[][];
  /** 顶层 / 一致性 / 对照表 / 依赖 / 场景 …: not tied to one shot. */
  general: H3qItem[];
}

const LINE = /^(ERROR|WARN|HINT)\s+(.*)$/;

/** Parse h3q's stdout. `titles` = shot titles in queue order (h3q writes 「镜N 标题前 30 字」). */
export function parseH3qOutput(output: string, titles: readonly string[]): H3qReport | null {
  const total = /结果:\s*ERROR\s*(\d+)\s*｜\s*WARN\s*(\d+)\s*｜\s*HINT\s*(\d+)/.exec(output);
  if (!total) return null;
  const report: H3qReport = { counts: { ERROR: Number(total[1]), WARN: Number(total[2]), HINT: Number(total[3]) }, shots: titles.map(() => []), general: [] };
  for (const raw of output.split(/\r?\n/)) {
    const m = LINE.exec(raw.trimEnd());
    if (!m) continue;
    const level = m[1] as H3qLevel; const body = m[2];
    const shot = /^镜(\d+)(?=[ ：])/.exec(body);
    const index = shot ? Number(shot[1]) - 1 : -1;
    if (index >= 0 && index < titles.length) {
      // 「镜3 标题：消息」/「镜3 标题 台词1：消息」：title known, so a 「：」 inside it does not split the message.
      const prefix = `镜${index + 1} ${titles[index].slice(0, 30)}`;
      const rest = body.startsWith(prefix) ? body.slice(prefix.length) : body.slice(shot![0].length);
      const sep = rest.indexOf("：");
      const sub = sep >= 0 ? rest.slice(0, sep).trim() : "";
      const message = sep >= 0 ? rest.slice(sep + 1).trim() : rest.trim();
      report.shots[index].push({ level, where: sub, message: sub ? `${sub}：${message}` : message });
      continue;
    }
    const sep = body.indexOf("：");
    report.general.push({ level, where: sep >= 0 ? body.slice(0, sep).trim() : "", message: sep >= 0 ? body.slice(sep + 1).trim() : body.trim() });
  }
  return report;
}

/** Card one-click fixes that answer an h3q finding (the rule itself stays in h3q). */
export function h3qFix(message: string): "dialogue_field" | "music_named" | null {
  if (/dialogue 不是空/.test(message)) return "dialogue_field";
  if (/点了背景音乐或配乐/.test(message)) return "music_named";
  return null;
}
