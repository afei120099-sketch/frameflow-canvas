import { instanceForPort, requestPort } from "@/lib/frameflow-instance";

// Inbox for externally produced images / queues. The worker has no fs; a loopback helper
// (scripts/inbox-server.mjs, started by `npm run dev` on Windows) does the file work.
// The helper port follows the canvas port. 5173 keeps 5193 even when FRAMEFLOW_INBOX_PORT is unset in workerd.
function isSameOriginRequest(request: Request, url: URL) {
  const secFetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  // Non-browser local tools (launch-canvas.ps1 health checks) send neither header; browsers always send Sec-Fetch-Site.
  if (!origin && (!secFetchSite || secFetchSite === "none")) return request.method === "GET";
  if (origin && origin !== url.origin) return false;
  if (secFetchSite && secFetchSite !== "same-origin") return false;
  return secFetchSite === "same-origin" || origin === url.origin;
}

async function proxy(request: Request) {
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) return Response.json({ error: "仅限本机" }, { status: 403 });
  if (!isSameOriginRequest(request, url)) return Response.json({ error: "禁止跨站请求" }, { status: 403 });
  try {
    const spec = instanceForPort(requestPort(request));
    const inboxPort = spec ? String(spec.inboxPort) : (process.env.FRAMEFLOW_INBOX_PORT || "5193");
    const result = await fetch(`http://127.0.0.1:${inboxPort}/${url.search}`, {
      method: request.method,
      headers: { "content-type": "application/octet-stream" },
      ...(request.method === "POST" ? { body: await request.arrayBuffer() } : {}),
    });
    return new Response(result.body, { status: result.status, headers: { "Content-Type": result.headers.get("content-type") ?? "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  } catch { return Response.json({ available: false, error: "收件箱服务未启动（node scripts/inbox-server.mjs）" }, { status: 503 }); }
}
export const GET = proxy;
export const POST = proxy;
