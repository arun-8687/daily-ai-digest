import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppConfig } from './config';
import { systemClock, type Clock } from './clock';
import { createContext, type AppContext } from './context';
import { HttpError } from './errors';
import { Router, readJsonObject, sendError, type RequestContext } from './http';
import { runMaintenance, sweepSla } from './sla';
import { serveStatic } from './static';
import { buildRouter, sessionFor } from './routes';

const JSON_LIMIT = 64 * 1024;
const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface TriageApp {
  readonly ctx: AppContext;
  /** Resolves with the bound port. Pass 0 to pick a free port. */
  start(port: number, host?: string): Promise<number>;
  stop(): Promise<void>;
}

/** Blocks cross-site form posts and fetches. Requests without an Origin header (CLIs, ingest) pass. */
function isCrossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

async function dispatch(ctx: AppContext, router: Router, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const match = router.resolve(method, pathname);

  if (match === 'method-not-allowed') {
    throw new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${pathname}`);
  }
  if (match === null) {
    const isApi = pathname.startsWith('/api/') || pathname === '/ingest' || pathname === '/healthz';
    if (!isApi && (method === 'GET' || method === 'HEAD') && ctx.config.webDir) {
      if (serveStatic(ctx.config.webDir, pathname, method, res)) return;
    }
    throw new HttpError(404, 'not_found', `No route for ${method} ${pathname}`);
  }
  if (UNSAFE.has(method) && isCrossOrigin(req)) {
    throw new HttpError(403, 'cross_origin', 'Cross-origin writes are not allowed');
  }

  const c: RequestContext = {
    ctx,
    req,
    res,
    url,
    params: match.params,
    session: sessionFor(ctx, req),
    json: (limit = JSON_LIMIT) => readJsonObject(req, limit),
  };
  await match.handler(c);
}

export function createTriageApp(config: AppConfig, options: { clock?: Clock; timers?: boolean } = {}): TriageApp {
  const ctx = createContext(config, options.clock ?? systemClock);
  const router = buildRouter();
  const server: Server = createServer((req, res) => {
    dispatch(ctx, router, req, res).catch((err: unknown) => sendError(res, err));
  });
  server.keepAliveTimeout = 65_000;

  const timers: NodeJS.Timeout[] = [];
  if (options.timers !== false) {
    timers.push(
      setInterval(() => {
        try {
          const n = sweepSla(ctx);
          if (n > 0) console.log(`[triage] SLA breached for ${n} incident(s)`);
        } catch (err) {
          console.error('[triage] SLA sweep failed', err);
        }
      }, config.sweepIntervalMs),
    );
    timers.push(
      setInterval(() => {
        try {
          runMaintenance(ctx);
        } catch (err) {
          console.error('[triage] maintenance failed', err);
        }
      }, 60_000),
    );
    for (const t of timers) t.unref();
  }

  return {
    ctx,
    start(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
        });
      });
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      ctx.db.close();
    },
  };
}
