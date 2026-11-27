import { randomUUID } from 'node:crypto';

export function isStartupModule(url = '') {
  const path = url.split('?')[0];
  return /^\/(?:@id\/|@vite\/)/.test(path) || /\.(?:[cm]?js|[jt]sx?|css)$/.test(path);
}

// Only the local development UI code is affected. Never clear site storage,
// change the origin, or alter caching of images/videos/API responses.
export function startupCacheMiddleware(req, res, next) {
  const moduleRequest = isStartupModule(req.url);
  if (moduleRequest) {
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
  }
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const type = String(this.getHeader('Content-Type') ?? '');
    if (moduleRequest || /^(?:text\/html|text\/css|(?:text|application)\/javascript)\b/i.test(type)) {
      this.setHeader('Cache-Control', 'no-store');
    }
    return writeHead.apply(this, args);
  };
  next();
}

export function localStartupCachePlugin() {
  return {
    // Vite 8 hashes plugin names for optimized dependency URLs. A new server
    // boot gets fresh URLs, bypassing already-corrupt immutable Chrome entries.
    // Reopening the shortcut on an existing server does NOT rebuild anything.
    name: `frameflow-local-startup-cache-${randomUUID()}`,
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(startupCacheMiddleware);
    },
  };
}
