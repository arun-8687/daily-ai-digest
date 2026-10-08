// The HTTP application: dispatch, the Origin check (D9), security headers, the SLA and maintenance timers, start and stop.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { systemClock, type Clock } from './clock';
import type { AppConfig } from './config';
import { createContext, type AppContext } from './context';
import { HttpError } from './errors';
import { sendError, sendJson, type Router } from './http';
import { runMaintenance, sweepSla } from './sla';
import { isReservedPath, serveStatic } from './static';
import { buildRouter } from './routes';

export interface TriageApp {
  readonly ctx: AppContext;
  /** Listens on host (default 127.0.0.1). Port 0 picks a free port. Resolves with the bound port. */
  start(port: number, host?: string): Promise<number>;
  /** Ends open streams, closes the server and the database. Safe to call twice. */
  stop(): Promise<void>;
}

export interface TriageAppOptions {
  clock?: Clock;
  /** false disables the SLA sweep and maintenance timers. Tests call sweepSla directly. */
  timers?: boolean;
}

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAINTENANCE_INTERVAL_MS = 60_000;

/** Unsafe methods that carry an Origin must come from the host being served (D9). */
function sameOriginOrAbsent(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function report(label: string, err: unknown): void {
  console.error(`[triage] ${label}:`, err);
}

export function createTriageApp(config: AppConfig, options: TriageAppOptions = {}): TriageApp {
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? true;
  const ctx = createContext(config, clock);
  const router: Router = buildRouter(ctx);
  const server = createServer((req, res) => {
    void dispatch(req, res);
  });

  let sweepTimer: NodeJS.Timeout | undefined;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (UNSAFE_METHODS.has(method) && !sameOriginOrAbsent(req)) {
        throw new HttpError(403, 'cross_origin', 'Cross-origin requests are not allowed');
      }

      const match = router.match(method, pathname);
      if (match.kind === 'found') {
        await match.handler({ req, res, url, params: match.params });
        return;
      }
      if (match.kind === 'method-not-allowed') {
        sendJson(
          res,
          405,
          { error: { code: 'method_not_allowed', message: `${method} is not allowed on ${pathname}` } },
          { Allow: match.allow.join(', ') },
        );
        return;
      }

      if (isReservedPath(pathname)) {
        throw new HttpError(404, 'not_found', `No such endpoint: ${method} ${pathname}`);
      }
      if (method === 'GET' || method === 'HEAD') {
        await serveStatic(config.webDir, req, res, pathname);
        return;
      }
      sendJson(
        res,
        405,
        { error: { code: 'method_not_allowed', message: `${method} is not allowed on ${pathname}` } },
        { Allow: 'GET, HEAD' },
      );
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err);
        return;
      }
      report('unhandled request error', err);
      sendJson(res, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
    }
  }

  function guarded(label: string, work: () => void): () => void {
    return () => {
      try {
        work();
      } catch (err) {
        report(label, err);
      }
    };
  }

  function startTimers(): void {
    sweepTimer = setInterval(guarded('SLA sweep failed', () => sweepSla(ctx)), config.sweepIntervalMs);
    maintenanceTimer = setInterval(guarded('maintenance failed', () => runMaintenance(ctx)), MAINTENANCE_INTERVAL_MS);
  }

  return {
    ctx,

    start(port: number, host = '127.0.0.1'): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          const address = server.address();
          const bound = typeof address === 'object' && address !== null ? address.port : port;
          if (timers) startTimers();
          resolve(bound);
        });
      });
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          // Ends keep-alive sockets and live SSE streams, so close() can finish.
          server.closeAllConnections();
        });
      }
      ctx.db.close();
    },
  };
}
