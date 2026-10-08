// Serves the built SPA from web/dist: exact files, index.html fallback for unknown page paths, traversal guard.
// /api, /ingest and /healthz are never served here.
import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { sendText } from './http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Paths that belong to the API and must never fall back to the SPA.
 * The router matches the raw, case-sensitive path, so this check also looks at the decoded, lowercased form:
 * /%61pi/x and /API/x are then reserved too and get a JSON 404 instead of the SPA HTML.
 */
export function isReservedPath(pathname: string): boolean {
  let normalized: string;
  try {
    normalized = decodeURIComponent(pathname);
  } catch {
    normalized = pathname;
  }
  normalized = normalized.toLowerCase();
  return (
    normalized === '/api' ||
    normalized.startsWith('/api/') ||
    normalized === '/ingest' ||
    normalized.startsWith('/ingest/') ||
    normalized === '/healthz' ||
    normalized.startsWith('/healthz/')
  );
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, stats: Stats, root: string): void {
  const relative = file.slice(root.length + 1).split(sep).join('/');
  const isHtml = relative.endsWith('.html');
  const cache = isHtml
    ? 'no-cache'
    : relative.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': cache,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * Answers a GET or HEAD for a non-API path.
 * - A file under webDir is served with its type and cache policy.
 * - An unknown page path (no file extension) gets index.html so the client router can take over.
 * - A missing asset (has an extension) is a 404, not an HTML page.
 * - webDir null (TRIAGE_WEB_DIR=none) disables the SPA.
 */
export async function serveStatic(
  webDir: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (webDir === null) {
    sendText(res, 404, 'Not found. The web app is disabled on this server.');
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad request path.');
    return;
  }
  if (decoded.includes('\0')) {
    sendText(res, 404, 'Not found.');
    return;
  }

  const root = resolve(webDir);
  // Traversal guard: the resolved file must stay inside root.
  const requested = resolve(root, `.${decoded}`);
  if (requested !== root && !requested.startsWith(root + sep)) {
    sendText(res, 404, 'Not found.');
    return;
  }

  let file = requested;
  let stats = await statOrNull(file);
  if (stats?.isDirectory()) {
    file = join(file, 'index.html');
    stats = await statOrNull(file);
  }
  if (stats?.isFile()) {
    sendFile(req, res, file, stats, root);
    return;
  }

  if (extname(decoded) !== '') {
    sendText(res, 404, 'Not found.');
    return;
  }

  const index = join(root, 'index.html');
  const indexStats = await statOrNull(index);
  if (!indexStats?.isFile()) {
    sendText(res, 404, 'The web app is not built. Run npm run build.');
    return;
  }
  sendFile(req, res, index, indexStats, root);
}
