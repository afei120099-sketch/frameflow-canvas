import { startClipboardImageServer } from './clipboard-image-server.mjs';

// Fixed loopback destination, no arbitrary commands, filenames or queue operations.
export function clipboardPlugin({ ensure = startClipboardImageServer, forward = fetch } = {}) {
  let starting;
  return {
    name: 'frameflow-clipboard-on-demand',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== '/__clipboard/image') return next();
        const fail = (code, message) => { response.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end(message); };
        const host = request.headers.host;
        if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host || '') || request.headers.origin !== `http://${host}`) return fail(403, '仅限本机画布');
        if (request.method !== 'POST') return fail(405, '仅支持 POST');
        if (request.headers['content-type'] !== 'image/png') return fail(415, '仅支持 PNG');
        try {
          const chunks = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 40 * 1024 * 1024) return fail(413, '图片过大');
            chunks.push(chunk);
          }
          starting ??= Promise.resolve().then(ensure).finally(() => { starting = undefined; });
          await starting;
          const result = await forward('http://127.0.0.1:5193/image', {
            method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(25000),
          });
          response.writeHead(result.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(await result.text());
        } catch (error) { fail(503, `本机复制服务暂不可用：${error.message}`); }
      });
    },
  };
}
