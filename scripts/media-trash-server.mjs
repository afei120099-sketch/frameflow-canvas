import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { assertLocalTrashRequest, isLocalDevOrigin, recycleMediaRequest } from './media-trash-service.ts';

const SERVICE = 'frameflow-media-recycle-v3';

function corsHeaders(origin) {
  const allow = isLocalDevOrigin(origin) && origin ? origin : 'http://127.0.0.1:5173';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-frameflow-action',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
}

export async function startMediaTrashServer() {
  if (process.platform !== 'win32') return;
  // Reuse only the current protocol. An older helper on this port must be restarted.
  try {
    const existing = await fetch('http://127.0.0.1:5189/', { signal: AbortSignal.timeout(800) });
    const body = await existing.json();
    if (body.service === SERVICE) return;
    if (body.service) throw Error('5189端口被其他回收站助手占用，请先结束旧进程后再启动');
    throw Error('5189端口被其他服务占用');
  } catch (error) {
    if (String(error.message).includes('5189端口')) throw error;
  }
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const reply = (status, value) => {
      res.writeHead(status, corsHeaders(origin));
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'OPTIONS') return reply(204, {});
      if (req.method === 'GET') return reply(200, { service: SERVICE, available: true });
      if (req.method !== 'POST') return reply(405, { error: '不支持此操作' });
      if (!isLocalDevOrigin(origin || null)) return reply(403, { error: '禁止跨站清理请求' });
      const pageOrigin = origin || 'http://127.0.0.1:5173';
      assertLocalTrashRequest(new Request(`${pageOrigin}/api/media-trash`, {
        method: 'POST',
        headers: { origin: origin || '', 'x-frameflow-action': req.headers['x-frameflow-action'] || '' },
      }));
      const request = new Request(`${pageOrigin}/api/media-trash${new URL(req.url, 'http://127.0.0.1').search}`, {
        method: 'POST',
        headers: { origin: pageOrigin, 'x-frameflow-action': 'recycle' },
        body: Readable.toWeb(req),
        duplex: 'half',
      });
      reply(200, await recycleMediaRequest(request));
    } catch (error) {
      reply(error.message?.includes('跨站') || error.message?.includes('本机') ? 403 : 409, { error: error.message || '清理失败，原素材保留' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(5189, '127.0.0.1', resolve);
  });
  server.unref();
  return server;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/media-trash-server.mjs')) {
  const server = await startMediaTrashServer();
  server?.ref();
}
