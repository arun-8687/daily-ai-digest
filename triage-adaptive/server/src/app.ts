import http from 'node:http';
import { type Clock, systemClock } from './clock';
import type { AppConfig } from './config';
import { type AppContext, closeContext, createContext } from './context';
import { sendError } from './http';
import { handleRequest } from './routes';
import { runMaintenance, sweepSla } from './sla';
import type { StreamHandle } from './sse';

export interface TriageApp {
  readonly ctx: AppContext;
  /** Listens on host (default 127.0.0.1). Resolves with the bound port; port 0 picks a free one. */
  start(port: number, host?: string): Promise<number>;
  /** Closes SSE streams, clears timers, closes the server and the database. Safe to call twice. */
  stop(): Promise<void>;
}

export interface TriageAppOptions {
  clock?: Clock;
  /** Runs the SLA sweep every config.sweepIntervalMs and maintenance every 60s. Default true. */
  timers?: boolean;
}

const MAINTENANCE_INTERVAL_MS = 60_000;

function guard(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[triage] ${label} failed`, err);
  }
}

export function createTriageApp(config: AppConfig, options: TriageAppOptions = {}): TriageApp {
  const clock = options.clock ?? systemClock;
  const ctx = createContext(config, clock);
  const streams = new Set<StreamHandle>();
  const env = { ctx, config, streams };
  const timers: NodeJS.Timeout[] = [];
  let stopping: Promise<void> | null = null;

  const server = http.createServer((req, res) => {
    handleRequest(env, req, res).catch((err: unknown) => sendError(res, err));
  });

  if (options.timers ?? true) {
    timers.push(
      setInterval(() => guard('SLA sweep', () => sweepSla(ctx)), config.sweepIntervalMs).unref(),
      setInterval(() => guard('maintenance', () => runMaintenance(ctx)), MAINTENANCE_INTERVAL_MS).unref(),
    );
  }

  async function shutdown(): Promise<void> {
    for (const t of timers) clearInterval(t);
    for (const s of [...streams]) s.close();
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    closeContext(ctx);
  }

  return {
    ctx,
    start(port: number, host: string = '127.0.0.1'): Promise<number> {
      if (stopping) return Promise.reject(new Error('The app has been stopped'));
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
        });
      });
    },
    stop(): Promise<void> {
      stopping ??= shutdown();
      return stopping;
    },
  };
}
