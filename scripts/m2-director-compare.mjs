import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Side-by-side table of two director trial reports (same briefs, request, schema, validator, compiler).
 * Counts only — no scores.
 *
 *   node scripts/m2-director-compare.mjs runtime/director-trials/<local>/report.json runtime/director-trials/<claude>/report.json
 */

const paths = process.argv.slice(2);
if (paths.length < 1) { console.error("usage: m2-director-compare.mjs <report.json> [<report.json> …]"); process.exit(2); }
const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));

const calls = (report) => report.trials.flatMap((trial) => trial.calls.map((call) => ({ ...call, brief: trial.id })));
const count = (items, test) => items.filter(test).length;
const hits = (report, pattern, briefs) => { const scoped = calls(report).filter((call) => !briefs || briefs.includes(call.brief)); return `${count(scoped, (call) => call.errors.some((error) => pattern.test(error)))} / ${scoped.length} 次调用违规`; };
const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);
const mean = (values) => values.length ? sum(values) / values.length : 0;

const rows = [
  ["模型", (r) => r.model ?? r.configuredModel ?? r.provider],
  ["导演运行规则", (r) => { const skill = r.trials.find((t) => t.runtimeSkill)?.runtimeSkill; return skill ? `${skill.version}（${skill.hash.slice(0, 12)}）` : "未注入"; }],
  ["一次通过率", (r) => `${count(r.trials, (t) => t.firstPassOk)} / ${r.trials.length}`],
  ["修正后通过率", (r) => `${count(r.trials, (t) => t.passed ?? t.status === "awaiting_confirmation")} / ${r.trials.length}`],
  ["平均调用次数", (r) => mean(r.trials.map((t) => t.calls.length)).toFixed(2)],
  ["平均规划耗时（每条需求，全部调用）", (r) => `${(mean(r.trials.map((t) => sum(t.calls.map((c) => c.durationMs)))) / 1000).toFixed(1)} s`],
  ["台词纪律（A、C：机器语法 / 翻译 / 语言标注 / 放不进 / 旁白 / 台词写进描述）", (r) => hits(r, /H3 机器语法|不能翻译|language 应为|language 不应为|放不进|no_voiceover|既是画面内开口|需用英文描述|在台词之外出现了中文/, ["A", "C"])],
  ["无对白纪律（B）", (r) => hits(r, /\[no_dialogue\]/, ["B"])],
  ["产品事实纪律（数字 / 未批准说法 / 禁止说法）", (r) => hits(r, /\[(no_numbers|unapproved_claim|forbidden_claim)\]/)],
  ["可读文字纪律（可读文字 / 生成界面）", (r) => hits(r, /\[(no_readable_text|no_generated_ui)\]/)],
  ["运镜冲突", (r) => hits(r, /自相矛盾|不在允许列表|既被允许又被禁止/)],
  ["禁止说法 / 主体类型漂移（B）", (r) => hits(r, /[forbidden_claim]/, ["B"])],
  ["镜头复杂度（通过计划：镜头数 / 每镜事件英文词数 / 每镜台词句数）", (r) => {
    const shots = r.trials.filter((t) => t.plan).flatMap((t) => t.plan.shots);
    if (!shots.length) return "无通过计划";
    return `${(shots.length / r.trials.filter((t) => t.plan).length).toFixed(1)} / ${mean(shots.map((s) => s.event.split(/\s+/).length)).toFixed(1)} / ${mean(shots.map((s) => s.dialogue.length)).toFixed(2)}`;
  }],
  ["总 token（输入 + 输出）", (r) => { const all = calls(r); return `${sum(all.map((c) => c.usage?.inputTokens))} + ${sum(all.map((c) => c.usage?.outputTokens))}`; }],
  ["API 成本", (r) => {
    const all = calls(r);
    if (r.provider === "local-lmstudio") return "本地（无 API 费用）";
    if (all.some((c) => c.billingUncertain)) return "有计费不确定的调用，见 report.json";
    const priced = all.filter((c) => typeof c.usage?.costUsd === "number");
    return priced.length === all.length ? `约 $${sum(priced.map((c) => c.usage.costUsd)).toFixed(4)}（按官方价目估算；实际以 Console 账单为准）` : "只有 usage，无法可靠计算";
  }],
];

const header = `| 项目 | ${reports.map((r) => r.provider).join(" | ")} |\n|---|${reports.map(() => "---").join("|")}|`;
const table = `${header}\n${rows.map(([label, cell]) => `| ${label} | ${reports.map((r) => String(cell(r)).replace(/\|/g, "/")).join(" | ")} |`).join("\n")}`;
const common = (report) => {
  const tally = new Map();
  for (const call of calls(report)) for (const rule of call.rules ?? []) tally.set(rule, (tally.get(rule) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([rule, n]) => `${rule} ×${n}`).join("，") || "无";
};
const out = `${table}\n\n最常见错误：\n${reports.map((r) => `- ${r.provider}：${common(r)}`).join("\n")}\n`;
console.log(out);
writeFileSync(join(dirname(paths.at(-1)), "compare.md"), out, "utf8");
