/**
 * 镜头卡片整页排版（用户 2026-11-11：「整个页面排版弄弄好看」——黑白灰、高级、简约，不要紫色）。
 * 只覆盖 shot-card-board.tsx 里 STYLE 的同名规则（拼在它后面，后写的赢），不改结构：
 * - 六列统一网格和间距；1080p / 1440p（含 Windows 125%–150% 缩放后 1500–1700 宽）都不横向滚动、不挤成竖字。
 * - 字号四档：镜头号 24 / 剧情 13.5 / 正文 13 / 标签说明 11.5 灰。
 * - 少边框少底色：卡片一层浅底 + 细线，参数格子改成两列「标签在上、数值在下」的小格，用细分隔线分区。
 * - 按钮：一律深底细边白字（用户 2026-11-11 不要白底块，见 shot-card-header.tsx），「渲染这一镜」靠亮边框和粗字当主按钮；复制 / ↑ / ↓ / 接尾帧 / 删 是一排图标。
 * - 状态：只有写错（红）和漏写（黄）带颜色，「检查通过」「未提交」都是灰。
 */
export const SC_LAYOUT_STYLE = `
/* ── 文字灰度：卡片页所有字色只在这里定（用户 2026-11-11：全是白字刺眼，要回到柔和的灰度层级） ──
   --sc-strong  近白：只给镜号、队列名、主按钮文字、选中的东西
   --paper      正文浅灰：剧情、分秒动作、台词、按钮字（卡片里大部分文字都读这个变量）
   --sc-value   次一档：参数数值、顶栏状态数字、小卡片标题
   --muted      再暗：摘要、说明
   --dim        最暗：标签（秒数、实际…）、时间码 */
.sc-root{--sc-strong:var(--ff-white);--sc-body:#cfcfcf;--sc-value:#b4b4b4;--paper:var(--sc-body);--muted:var(--ff-text-2);--dim:var(--ff-text-3);color:var(--paper)}
.sc-root .sc-code,.sc-root .scf-head h2,.sc-root .sc-btn.primary,.sc-root .sc-slate .sc-render-btn:not(:disabled),.sc-root .scf-stats button.on,.sc-root .sc-versions button.on,.sc-root .scf-card.on b{color:var(--sc-strong)}
.sc-root .sc-cell>b,.sc-root .scf-stats b,.sc-root .scf-card b{color:var(--sc-value)}
.sc-root .scf-stats .bad b,.sc-root .sc-cell.stop>b,.sc-root .scf-card.bad b{color:var(--stop)}
.sc-root .scf-stats .warn b,.sc-root .scf-card.warn b{color:var(--warn)}
.sc-root .scf-card span,.sc-root .scf-card.warn span{color:var(--muted)}
.sc-root .scf-card.bad span{color:var(--stop)}
.sc-root .sc-beats time{color:var(--dim)}
.sc-root .sc-lede{font-weight:400}
/* ── 网格 ── */
.sc-reel{padding:0 28px 60px}
.sc-legend,.sc-row{grid-template-columns:124px 232px 132px 268px minmax(300px,1fr) 168px;column-gap:20px}
.sc-root .sc-legend{position:sticky;top:0;z-index:6;padding:8px 18px;margin:0 0 10px;font:11.5px var(--mono);letter-spacing:.14em;color:var(--dim);background:var(--bay);border-bottom:1px solid var(--line)}
.sc-legend span:nth-child(2){min-width:0}
.sc-row{row-gap:12px;padding:16px 18px;margin-bottom:10px;border:1px solid var(--line);border-radius:12px;background:var(--panel);scroll-margin-top:48px}
.sc-row::before{left:-1px;top:16px;bottom:16px;width:2px;background:transparent}
.sc-row.warn::before{background:var(--warn)}.sc-row.bad::before{background:var(--stop)}
.sc-row.bad{border-color:var(--line)}
.sc-row:hover{border-color:var(--line-2)}
.sc-chapter h3{margin:18px 0 10px;font:600 14px var(--display);color:var(--paper)}
.sc-chapter h3 span{color:var(--dim)}

/* ── 镜头列：镜号 / 标题 / 状态 / 按钮 ── */
.sc-slate{gap:8px;align-items:stretch}
.sc-code{font:600 24px/1 var(--mono);letter-spacing:-.01em;color:var(--paper)}
.sc-name{font-size:12px;line-height:1.45;color:var(--muted);word-break:break-all}
.sc-chip{align-self:flex-start;padding:1px 8px;border-color:var(--line-2);color:var(--muted);font-size:11.5px;line-height:18px;background:transparent}
.sc-chip.cold,.sc-chip.go{border-color:var(--line-2);color:var(--muted)}
.sc-chip.go::before{content:"✓ ";color:var(--dim)}
.sc-chip.amber{border-color:rgba(214,189,132,.45);color:var(--warn)}
.sc-chip.stop{border-color:rgba(220,138,124,.5);color:var(--stop);background:transparent}
.sc-slate .sc-render-btn,.sc-slate .sc-edit-btn{justify-content:center;width:100%;margin-top:0;padding:6px 8px;font-size:12.5px;box-sizing:border-box}
.sc-slate .sc-render-btn{margin-top:4px}
.sc-slate .sc-render-btn:disabled{background:transparent;border-color:var(--line-2);color:var(--dim);font-weight:400}
.sc-slate .sc-edit-btn{background:transparent;border-color:var(--line-2);color:var(--paper)}
.sc-slate .sc-edit-btn:hover:not(:disabled){border-color:var(--muted);background:var(--panel-2)}
.sc-row-tools{display:flex;justify-content:space-between;gap:2px;margin-top:0}
.sc-row-tools button{flex:1;min-width:0;height:26px;display:grid;place-items:center;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dim)}
.sc-row-tools button:hover:not(:disabled){color:var(--paper);border-color:var(--line-2);background:var(--panel-2)}
.sc-row-tools button.del:hover:not(:disabled){color:var(--stop);border-color:rgba(220,138,124,.5)}
.sc-row-tools svg{width:14px;height:14px}
.sc-toggle{margin-top:0;color:var(--dim)}.sc-toggle:hover{color:var(--paper)}

/* ── 参考图 / 关键帧 ── */
.sc-refs{flex-wrap:wrap;align-content:flex-start;gap:8px;min-width:0}
.sc-thumb,.sc-ref-missing{width:72px}
.sc-frame{border-radius:6px;border-color:var(--line)}
.sc-frame i{font-size:11px;line-height:15px;color:var(--paper)}
.sc-thumb figcaption{font-size:11.5px;color:var(--dim)}
.sc-ref-missing{border-radius:6px;font-size:11.5px}
.sc-kf-add{aspect-ratio:auto;height:72px;max-height:none;border-radius:8px;font-size:12px}
.sc-kf-add:hover:not(:disabled){border-color:var(--muted);color:var(--paper);background:var(--panel-2)}
.sc-kf-main .sc-frame{border-color:var(--ff-white);box-shadow:0 0 0 1px var(--ff-white)}
.sc-kf-chain{font-size:11.5px;color:var(--muted);border-color:var(--line-2)}

/* ── 参数：两列整齐小格，标签在上（小、灰），数值在下 ── */
.sc-cells{grid-template-columns:1fr 1fr;gap:0 14px;align-content:start}
.sc-cell{gap:1px;padding:6px 0 7px;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;min-height:40px;box-sizing:border-box}
.sc-cell>span{font:11.5px var(--sans);letter-spacing:0;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-cell>b{font:500 13px/1.4 var(--sans);color:var(--paper);white-space:nowrap}
.sc-cell.wide>b{white-space:normal}
.sc-cell>b small{font:11.5px var(--sans);color:var(--dim)}
.sc-cell.stop{border-color:var(--line);background:transparent}.sc-cell.stop>b{color:var(--stop)}
.sc-cell.go>b{color:var(--paper)}.sc-cell.cold>b{color:var(--muted);font-size:12px}
.sc-role{gap:5px}
.sc-role i,.sc-role button.lines{font-size:11px;line-height:16px}
.sc-role i.go{border-color:var(--line-2);color:var(--muted)}
.sc-role i.stop{background:transparent}
.sc-role button.lines.on{color:var(--paper)}
.sc-seg-switch{margin-top:4px;padding:2px;border-radius:7px;background:transparent;border-color:var(--line-2)}
.sc-seg-switch button{padding:3px 0;font-size:12px}
.sc-seg-switch button.on,.sc-seg-switch button.on.u{background:var(--panel-2);color:var(--paper);font-weight:600;box-shadow:inset 0 0 0 1px var(--line-2)}

/* ── 剧情 ── */
.sc-lede{margin:0 0 8px;font-size:14px;line-height:1.6;font-weight:500}
.sc-beats{border-left:1px solid var(--line)}
.sc-beats li{grid-template-columns:58px 1fr;padding:2px 0 8px 12px}
.sc-beats li::before{top:9px;width:5px;height:5px;left:-3px;border-color:var(--muted)}
.sc-beats li.start::before{background:var(--muted)}
.sc-beats time{font:11.5px/22px var(--mono);color:var(--muted)}
.sc-beats li.start time{color:var(--dim)}
.sc-beats li>div{font-size:13.5px;line-height:1.7;color:var(--paper)}
.sc-beat-cam{font-size:11.5px;color:var(--dim)}
.sc-beats q,.sc-dialogue q{border-left-color:var(--muted);background:var(--panel-2);font-size:13px}
.sc-beats q em{color:var(--muted);font-size:11.5px}
.sc-more summary{font:11.5px var(--sans);letter-spacing:0}
.sc-more summary::before{color:var(--dim)}
.sc-more>p em{font:11.5px var(--sans);color:var(--dim)}

/* ── 视频：没视频时只占一小块，有视频时缩略图清楚 ── */
.sc-video{border-radius:8px}
.sc-root .sc-video.empty{aspect-ratio:auto!important;height:72px;background:transparent;border-color:var(--line-2)}
.sc-video>button svg{width:34px;height:34px;padding:8px;border-color:var(--ff-white);color:var(--ff-white)}
.sc-video i{font-size:11.5px;color:var(--paper)}
.sc-versions button{font-size:11.5px}

/* ── 检查结果：细线框，不再大块底色 ── */
.sc-checks{padding:8px 12px;border-radius:8px;background:transparent}
.sc-checks.bad{border-color:rgba(220,138,124,.35);background:transparent}
.sc-checks.warn{border-color:rgba(214,189,132,.28);background:transparent}
.sc-checks li{font-size:12.5px}
.sc-checks li.e::before{box-shadow:none}

/* ── 顶栏下的提示条统一成安静的细框 ── */
.sc-bulk{border-color:var(--line-2);background:var(--panel);border-radius:8px}
.sc-bulk.kf{border-color:var(--line-2);background:var(--panel);color:var(--paper)}

/* ── 窄一些的屏（1080p 放大 125% / 1440p 放大 150%，或窗口没最大化） ── */
@media (max-width:1600px){
  .sc-legend,.sc-row{grid-template-columns:116px 196px 116px 236px minmax(260px,1fr) 148px;column-gap:16px}
  .sc-thumb,.sc-ref-missing{width:60px}
  .sc-reel{padding:0 20px 48px}
}
@media (max-width:1280px){
  .sc-legend,.sc-row{grid-template-columns:112px 172px 108px 220px minmax(220px,1fr) 132px;column-gap:14px}
  .sc-thumb,.sc-ref-missing{width:52px}
  .sc-row{padding:14px}
}
@media (max-width:1080px){
  .sc-row{grid-template-columns:112px minmax(0,1fr) 132px}
  .sc-reel{padding:0 16px 40px}
}

/* ── 关键帧列按需显示：整份队列都没用关键帧 / 接帧时（lib/shot-card-view-rules.ts）去掉这一列，宽度让给剧情 ── */
.sc-reel.no-kf .sc-legend,.sc-reel.no-kf .sc-row:not(.editing){grid-template-columns:124px 232px 268px minmax(300px,1fr) 168px}
@media (max-width:1600px){.sc-reel.no-kf .sc-legend,.sc-reel.no-kf .sc-row:not(.editing){grid-template-columns:116px 196px 236px minmax(260px,1fr) 148px}}
@media (max-width:1280px){.sc-reel.no-kf .sc-legend,.sc-reel.no-kf .sc-row:not(.editing){grid-template-columns:112px 172px 220px minmax(220px,1fr) 132px}}
@media (max-width:1080px){.sc-reel.no-kf .sc-row:not(.editing){grid-template-columns:112px minmax(0,1fr) 132px}}
.sc-root .sc-kf-small{padding:3px 8px;border-color:var(--line);background:transparent;color:var(--muted);font-size:12px;font-weight:400}
.sc-root .sc-kf-small:hover:not(:disabled){border-color:var(--line-2);color:var(--paper)}

/* 「未入队」是默认状态，不是问题：最淡的灰，不抢眼 */
.sc-root .sc-chip.idle{border-color:transparent;background:transparent;color:var(--dim)}

/* ── 章节标题旁「本章入队」：小、灰，悬停才亮 ── */
.sc-chapter h3{align-items:center}
.sc-root .sc-chapter-go{margin-left:6px;padding:2px 10px;border-color:var(--line-2);background:transparent;color:var(--muted);font:400 12px var(--display);letter-spacing:0}
.sc-root .sc-chapter-go:hover:not(:disabled){border-color:var(--paper);color:var(--sc-strong)}
.sc-root .sc-chapter-go:disabled{color:var(--dim);border-color:var(--line);cursor:default}
`;
