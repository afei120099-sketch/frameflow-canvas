import { showCopyToast } from "./copy-toast.ts";

function copyWithCommand(text: string) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  return ok;
}

/**
 * Copy plain text. The clipboard call starts inside the click so the browser still treats it as a user action.
 * On success a small toast shows bottom-right for ~1.5 s (lib/copy-toast.ts); pass toast=false to skip it or a text to say more.
 */
export function copyPlainText(value: string, toast: string | false = "已复制"): Promise<boolean> {
  const text = value.trim();
  if (!text || typeof document === "undefined") return Promise.resolve(false);
  const done = (ok: boolean) => { if (ok && toast) showCopyToast(toast); return ok; };
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => done(true), () => done(copyWithCommand(text)));
  return Promise.resolve(done(copyWithCommand(text)));
}
