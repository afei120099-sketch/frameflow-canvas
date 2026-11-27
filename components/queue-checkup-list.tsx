"use client";

import { groupQueueWarnings, checkupTotals } from "@/lib/queue-checkup";

/**
 * 镜头队列的体检提示：按镜头分组、可折叠。
 * 每条前面的记号用形状区分（三角 = 要核对，空心圆 = 写法建议），颜色只是加强。
 * 样式在 app/panels.css 的「体检列表」一节。
 *
 * 用法（components/shot-queue-panel.tsx，替换原来逐条 <p className="backup-note">△ …</p> 的那一行）：
 *   {queue && <QueueCheckupList warnings={shotQueueWarnings(queue)} />}
 */
export function QueueCheckupList({ warnings }: { warnings: readonly string[] }) {
  const groups = groupQueueWarnings(warnings);
  if (!groups.length) return null;
  const totals = checkupTotals(groups);
  // 默认收起：面板里不再铺一长串说明，点开才看。
  return <details className="checkup">
    <summary>体检提示<small>{groups.length} 镜{totals.warn > 0 ? ` · ${totals.warn} 条要核对` : ""}{totals.hint > 0 ? ` · ${totals.hint} 条写法建议` : ""}</small></summary>
    {groups.map((group) => <details className="checkup-shot" key={group.title} open={group.warn > 0}>
      <summary><b title={group.title}>{group.title}</b><small>{group.warn > 0 && <span className="checkup-count warn">{group.warn} 要核对</span>}{group.hint > 0 && <span>{group.hint} 建议</span>}</small></summary>
      <ul>{group.items.map((item, index) => <li key={index}><i className={`checkup-mark ${item.level}`} aria-hidden="true" /><span>{item.level === "warn" ? <span className="sr-only">要核对：</span> : <span className="sr-only">建议：</span>}{item.message}</span></li>)}</ul>
    </details>)}
  </details>;
}
