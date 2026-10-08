// Live stream (D12): SSE with replay from Last-Event-ID, resync rules, a 15 s ping that re-checks the session,
// and a 1 MB backpressure close. Replay and hub.add happen in one synchronous block, so nothing is missed or duplicated.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findSession } from './auth';
import type { AppContext } from './context';
import type { Database } from './db';
import type { Frame, Subscriber } from './hub';

/** More events than this to replay means resync instead (D12). */
export const REPLAY_LIMIT = 5000;
/** A subscriber whose unsent backlog exceeds this is closed; it resumes from its last id. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

interface EventRow {
  seq: number;
  type: string;
  data: string;
}

type ReplayPlan = { kind: 'resync' } | { kind: 'replay'; rows: EventRow[] };

function formatEvent(seq: number, type: string, data: string): string {
  return `id: ${seq}\nevent: ${type}\ndata: ${data}\n\n`;
}

function headSeq(db: Database): number {
  return db.get<{ head: number }>('SELECT COALESCE(MAX(seq), 0) AS head FROM events')?.head ?? 0;
}

/** Decides between replay and resync for a client that reports `raw` as its last event id. */
function planReplay(db: Database, raw: string, head: number): ReplayPlan {
  if (!/^\d+$/.test(raw)) return { kind: 'resync' };
  const lastId = Number(raw);
  if (!Number.isSafeInteger(lastId) || lastId > head) return { kind: 'resync' };

  // Events after lastId must still be retained. The first missing seq is lastId + 1.
  const oldest = db.get<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM events')?.seq ?? null;
  if (oldest !== null && lastId + 1 < oldest) return { kind: 'resync' };

  const rows = db.all<EventRow>(
    'SELECT seq, type, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
    lastId,
    REPLAY_LIMIT + 1,
  );
  if (rows.length > REPLAY_LIMIT) return { kind: 'resync' };
  return { kind: 'replay', rows };
}

/** Last-Event-ID header first, then ?lastEventId=. Undefined when neither is sent. */
function reportedLastId(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers['last-event-id'];
  if (typeof header === 'string') return header;
  return url.searchParams.get('lastEventId') ?? undefined;
}

/**
 * Opens the SSE response and registers it with the hub. The caller has already checked that the session may read.
 * `token` is the session cookie value, re-checked on every heartbeat.
 */
export function openStream(ctx: AppContext, req: IncomingMessage, res: ServerResponse, url: URL, token: string): void {
  res.on('error', () => undefined);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    ctx.hub.remove(subscriber);
  };
  const finish = (hard: boolean): void => {
    if (closed) return;
    cleanup();
    if (hard) res.destroy();
    else res.end();
  };

  const subscriber: Subscriber = {
    lastSent: 0,
    deliver(frame: Frame): void {
      if (closed) return;
      res.write(formatEvent(frame.seq, frame.type, frame.data));
      if (res.writableLength > MAX_BUFFERED_BYTES) finish(true);
    },
  };

  // --- One synchronous block: hello, replay or resync, then hub.add. No await between them. ---
  const serverTime = ctx.clock.now();
  const head = headSeq(ctx.db);
  res.write(`event: hello\ndata: ${JSON.stringify({ serverTime, head })}\n\n`);

  const raw = reportedLastId(req, url);
  if (raw === undefined) {
    subscriber.lastSent = head;
  } else {
    const plan = planReplay(ctx.db, raw, head);
    if (plan.kind === 'resync') {
      res.write(`id: ${head}\nevent: resync\ndata: ${JSON.stringify({ head })}\n\n`);
    } else {
      for (const row of plan.rows) {
        res.write(formatEvent(row.seq, row.type, row.data));
      }
    }
    subscriber.lastSent = head;
  }
  ctx.hub.add(subscriber);
  // --- end of synchronous block ---

  heartbeat = setInterval(() => {
    if (closed) return;
    if (findSession(ctx, token) === null) {
      finish(false);
      return;
    }
    res.write(`event: ping\ndata: ${JSON.stringify({ serverTime: ctx.clock.now() })}\n\n`);
  }, ctx.config.sseHeartbeatMs);

  res.on('close', cleanup);
}
