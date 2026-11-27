// The app runs in a worker; native Windows file operations stay in a loopback-only helper.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
function localTrashAllowed(request: Request) {
  const url = new URL(request.url);
  if (!LOCAL_HOSTS.has(url.hostname)) return false;
  const secFetchSite = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  // Non-browser local tools (launch-canvas.ps1 health checks) send neither header; browsers always send Sec-Fetch-Site.
  if (!origin && (!secFetchSite || secFetchSite === 'none')) return request.method === 'GET';
  if (origin && origin !== url.origin) return false;
  if (secFetchSite && secFetchSite !== 'same-origin') return false;
  if (secFetchSite !== 'same-origin' && origin !== url.origin) return false;
  if (request.method === 'POST' && request.headers.get('x-frameflow-action') !== 'recycle') return false;
  return true;
}

async function proxy(request: Request) {
  const url = new URL(request.url);
  if (!localTrashAllowed(request)) return Response.json({ error: '禁止跨站清理请求' }, { status: 403 });
  try {
    const result = await fetch(`http://127.0.0.1:5189${url.search}`, {
      method: request.method,
      headers: { origin: request.headers.get('origin') || url.origin, 'x-frameflow-action': request.headers.get('x-frameflow-action') ?? '', 'content-type': 'application/octet-stream' },
      ...(request.method === 'POST' ? { body: request.body } : {}),
    });
    return new Response(result.body, { status: result.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ available: false, error: '本机回收站助手未启动，未清理任何素材' }, { status: 503 }); }
}
export const GET = proxy;
export const POST = proxy;
