import { createReadStream, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the built web app. Unknown routes without a file extension fall back to
 * index.html so client-side URLs work. Returns false when nothing matched.
 */
export function serveStatic(webDir: string, pathname: string, method: string, res: ServerResponse): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const candidate = normalize(join(webDir, decoded));
  if (candidate !== webDir && !candidate.startsWith(webDir + sep)) return false;

  let target = candidate;
  if (!isFile(target)) {
    if (extname(pathname)) return false;
    target = join(webDir, 'index.html');
  }
  if (!isFile(target)) return false;

  const hashed = target.includes(`${sep}assets${sep}`);
  const size = statSync(target).size;
  res.writeHead(200, {
    'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  if (method === 'HEAD') {
    res.end();
  } else {
    createReadStream(target).pipe(res);
  }
  return true;
}
