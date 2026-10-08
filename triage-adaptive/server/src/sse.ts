import type { IncomingMessage, ServerResponse } from 'node:http';
import { findSession } from './auth';
import type { AppConfig } from './config';
import type { AppContext } from './context';
import type { Frame, Subscriber } from './hub';
import { baseHeaders } from './http';

/** More events than this to replay means a resync instead (D12). */
export const REPLAY_LIMIT = 5000;
/** A subscriber whose socket buffer grows past this is closed; it resumes from its last id. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
const RETRY_MS = 2000;

/** Anything the app can close on shutdown. */
export interface StreamHandle {
  close(): void;
}

export interface OpenStreamOptions {
  ctx: AppContext;
  config: AppConfig;
  req: IncomingMessage;
  res: ServerResponse;
  /** The session token, re-checked on every heartbeat. */
  token: string | null;
  /** Last-Event-ID (header, else ?lastEventId). null means absent: start at head, no replay. */
  lastIdRaw: string | null;
  /** The app-wide set of open streams, so shutdown can close them. */
  streams: Set<StreamHandle>;
}

/** Splits a payload into `data:` lines so that a newline can never break the frame. */
function dataField(payload: string): string {
  return payload
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
}

function currentHead(ctx: AppContext): number {
  return ctx.db.get<{ head: number }>('SELECT COALESCE(MAX(seq), 0) AS head FROM events')?.head ?? 0;
}

/** A canonical non-negative safe integer, or null when the id is malformed. */
function parseLastId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Opens a live SSE stream (D12). Headers, `retry`, `hello`, then either a replay of the missed
 * events or a resync. The replay (or resync) and hub.add run in ONE synchronous block: no await
 * sits between reading the head and registering the subscriber, so no committed event is missed
 * or delivered twice.
 */
export function openStream(o: OpenStreamOptions): void {
  const { ctx, config, req, res, token, lastIdRaw, streams } = o;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;

  const sub: Subscriber = {
    lastSent: 0,
    deliver(frame: Frame): void {
      if (closed) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        close();
        return;
      }
      res.write(`id: ${frame.seq}\nevent: ${frame.type}\n${dataField(frame.data)}\n\n`);
      sub.lastSent = frame.seq;
    },
  };
  const handle: StreamHandle = { close };

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer !== null) clearInterval(timer);
    ctx.hub.remove(sub);
    streams.delete(handle);
    if (!res.writableEnded) res.end();
  }

  function heartbeat(): void {
    if (closed) return;
    const session = token === null ? null : findSession(ctx, token);
    if (session === null) {
      close();
      return;
    }
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      close();
      return;
    }
    res.write(`event: ping\ndata: ${JSON.stringify({ serverTime: ctx.clock.now() })}\n\n`);
  }

  res.writeHead(
    200,
    baseHeaders({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    }),
  );
  res.write(`retry: ${RETRY_MS}\n\n`);
  req.socket.setNoDelay(true);

  // --- one synchronous block: read head, replay or resync, register the subscriber ---
  const head = currentHead(ctx);
  res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: ctx.clock.now(), head })}\n\n`);
  sub.lastSent = head;

  if (lastIdRaw !== null) {
    const lastId = parseLastId(lastIdRaw);
    const oldest = ctx.db.get<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM events')?.seq ?? null;
    const pending =
      lastId === null
        ? 0
        : (ctx.db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM (SELECT seq FROM events WHERE seq > ? AND seq <= ? LIMIT ?)',
            lastId,
            head,
            REPLAY_LIMIT + 1,
          )?.n ?? 0);
    const mustResync =
      lastId === null ||
      lastId > head ||
      (oldest !== null && lastId < oldest - 1) ||
      pending > REPLAY_LIMIT;

    if (mustResync) {
      res.write(`id: ${head}\nevent: resync\n${dataField(JSON.stringify({ head }))}\n\n`);
    } else {
      const rows = ctx.db.all<{ seq: number; type: string; data: string }>(
        'SELECT seq, type, data FROM events WHERE seq > ? AND seq <= ? ORDER BY seq',
        lastId,
        head,
      );
      for (const row of rows) {
        res.write(`id: ${row.seq}\nevent: ${row.type}\n${dataField(row.data)}\n\n`);
      }
    }
  }

  ctx.hub.add(sub);
  streams.add(handle);
  // The response's close is the disconnect signal. IncomingMessage 'close' fires once the request
  // body is consumed, so it must not be used here.
  res.on('close', close);
  res.on('error', close);
  timer = setInterval(heartbeat, config.sseHeartbeatMs);
}
