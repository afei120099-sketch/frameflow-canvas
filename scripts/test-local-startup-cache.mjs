import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { isStartupModule, localStartupCachePlugin, startupCacheMiddleware } from './local-startup-cache.mjs';

assert.notEqual(localStartupCachePlugin().name, localStartupCachePlugin().name);
assert.equal(localStartupCachePlugin().apply, 'serve');
assert.equal(isStartupModule('/@fs/D:/assets/source.png'), false);
assert.equal(isStartupModule('/@fs/D:/assets/source.mp4'), false);
assert.equal(isStartupModule('/@fs/D:/code/module.js?v=test'), true);
const server = createServer((req, res) => startupCacheMiddleware(req, res, () => {
  const media = req.url.startsWith('/media');
  const api = req.url.startsWith('/api/');
  res.setHeader('Content-Type', media ? 'video/mp4' : api ? 'application/json' : req.url === '/' ? 'text/html' : 'text/javascript');
  res.setHeader('Cache-Control', 'max-age=31536000,immutable');
  if (req.headers['if-none-match']) res.statusCode = 304;
  res.end('fixture');
}));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  for (const path of ['/', '/@id/__x00__virtual:vinext-app-browser-entry', '/node_modules/.vite/deps/react.js?v=old', '/app/page.tsx', '/media/test.mp4', '/api/inbox?op=projects']) {
    const result = await new Promise((resolve, reject) => {
      get({ hostname: '127.0.0.1', port: server.address().port, path, headers: path === '/' ? {} : { 'If-None-Match': 'old' } }, res => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode, cache: res.headers['cache-control'] }));
      }).on('error', reject);
    });
    const data = path.startsWith('/media') || path.startsWith('/api/');
    assert.equal(result.cache, data ? 'max-age=31536000,immutable' : 'no-store', path);
    assert.equal(result.status, data ? 304 : 200, path);
  }
  console.log('PASS real HTTP: startup HTML/modules no-store; stale module validators bypassed; media/API untouched; unique boot fingerprints.');
} finally { await new Promise(resolve => server.close(resolve)); }
