/** Runs in <head> before hydration; deliberately matches only the two browser notices.
 * Not an error boundary: ordinary JS exceptions and promise failures still surface. */
export const RESIZE_NOTICE_GUARD_SCRIPT = String.raw`(function(){
  if(window.__frameflowResizeNoticeGuard)return;
  window.__frameflowResizeNoticeGuard=true;
  var notice=/^(?:Uncaught\s+(?:Error:\s*)?)?ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/;
  window.addEventListener('error',function(event){
    var message=String(event.message||(event.error&&event.error.message)||'').trim();
    if(!notice.test(message))return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },true);
})();`;

export function installResizeNoticeGuard(){
  // The late path also covers existing tabs receiving a hot update without a reload.
  if(typeof window!=='undefined') {
    const target=window as Window & {__frameflowResizeNoticeGuard?:boolean};
    if(target.__frameflowResizeNoticeGuard)return;
    target.__frameflowResizeNoticeGuard=true;
    window.addEventListener('error',event=>{
      const message=String(event.message||event.error?.message||'').trim();
      if(!/^(?:Uncaught\s+(?:Error:\s*)?)?ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/.test(message))return;
      event.preventDefault();event.stopImmediatePropagation();
    },true);
  }
}
