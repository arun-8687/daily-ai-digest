import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './errors';
import { baseHeaders, notFound } from './http';

/** Content-Security-Policy sent with every HTML response (SPEC section 2). */
export const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function regularFile(p: string): Promise<string | null> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() ? p : null;
  } catch {
    return null;
  }
}

function cacheControl(file: string): string {
  // Vite emits content-hashed files under assets/; those can be cached forever.
  return /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const st = await fs.promises.stat(file);
  const ext = path.extname(file).toLowerCase();
  const headers = baseHeaders({
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': cacheControl(file),
  });
  if (ext === '.html') headers['Content-Security-Policy'] = CSP;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(file), res);
}

/**
 * Serves the built SPA from webDir. Unknown non-API GET paths fall back to index.html. A path
 * that resolves outside webDir is a 404. With webDir null (or no build) the answer is a JSON 404.
 */
export async function serveStatic(
  webDir: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (webDir === null) throw notFound('No web build is being served');
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'bad_request', 'Malformed path');
  }
  if (decoded.includes('\0')) throw notFound();

  const root = path.resolve(webDir);
  const rel = decoded.replace(/^\/+/, '');
  const target = path.resolve(root, rel === '' ? 'index.html' : rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw notFound();

  const file = (await regularFile(target)) ?? (await regularFile(path.join(root, 'index.html')));
  if (file === null) throw notFound();
  await sendFile(req, res, file);
}
