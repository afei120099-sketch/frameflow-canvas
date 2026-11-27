export const COMFYUI_SERVER_URL = "http://127.0.0.1:8188";
export const COMFYUI_PROXY_PATH = "/comfyui";

export function getComfyWebSocketUrl(pageHostname: string) {
  if(typeof window!=="undefined") {
    const target=new URL(`${COMFYUI_PROXY_PATH}/ws`,window.location.href);
    target.protocol=target.protocol==="https:"?"wss:":"ws:";
    return target.toString();
  }
  const target = new URL(COMFYUI_SERVER_URL);
  // ComfyUI's origin guard compares hostnames. Use the same loopback spelling as the page.
  if ((target.hostname === "localhost" || target.hostname === "127.0.0.1") && (pageHostname === "localhost" || pageHostname === "127.0.0.1")) target.hostname = pageHostname;
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = "/ws";
  return target.toString();
}
