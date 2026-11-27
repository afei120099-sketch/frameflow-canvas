// 复制成功的轻提示：右下角一小条，约 1.5 秒后淡出，不挡内容、点不到（pointer-events:none）。全站复制统一用这个。
// 只用 app/tokens.css 的灰阶 token。页面上同一时间只有一条，新的替换旧的。
export const COPY_TOAST_MS = 1500;
let timer: number | undefined;

export function showCopyToast(text = "已复制", ms = COPY_TOAST_MS) {
  if (typeof document === "undefined") return;
  let node = document.getElementById("ff-copy-toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "ff-copy-toast";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    Object.assign(node.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "100002", maxWidth: "min(360px, calc(100vw - 32px))", padding: "6px 12px", border: "1px solid var(--ff-border-strong, #3a3a3a)", borderRadius: "8px", background: "var(--ff-raised, #1b1b1b)", color: "var(--ff-text-2, #a8a8a8)", font: "12.5px/1.5 var(--ff-font, sans-serif)", boxShadow: "var(--ff-shadow, 0 12px 32px -8px rgba(0,0,0,.6))", pointerEvents: "none", transition: "opacity .25s", opacity: "0" } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(node);
  }
  node.textContent = text;
  requestAnimationFrame(() => { if (node) node.style.opacity = "1"; });
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { if (node) node.style.opacity = "0"; }, ms);
}
