import type { ServerResponse, IncomingMessage } from 'node:http';
import type { AppContext } from './context';
import { findSession, type AuthSession } from './auth';
import type { Frame, Subscriber } from './hub';

const REPLAY_LIMIT = 5000;
/** A client that falls this far behind is disconnected. It resumes from Last-Event-ID on reconnect. */
const MAX_BUFFERED_BYTES = 1_000_000;

function frameText(id: number | null, event: string, data: string): string {
  return `${id === null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${data}\n\n`;
}

class StreamSubscriber implements Subscriber {
  lastSent: number;

  constructor(
    private readonly res: ServerResponse,
    private readonly onOverflow: () => void,
    initial: number,
  ) {
    this.lastSent = initial;
  }

  deliver(frame: Frame): void {
    this.lastSent = frame.seq;
    this.write(frameText(frame.seq, frame.type, frame.data));
  }

  write(text: string): void {
    if (this.res.writableEnded || this.res.destroyed) return;
    this.res.write(text);
    if (this.res.writableLength > MAX_BUFFERED_BYTES) this.onOverflow();
  }
}

/**
 * Opens a Server-Sent Events stream.
 *
 * Resume contract: a reconnect sends the last event id it saw (Last-Event-ID header from
 * EventSource, or ?lastEventId= for manual reconnects). The server replays exactly the
 * events with seq greater than that id. Replay and subscription happen in the same
 * synchronous block, so nothing is missed or duplicated in between.
 *
 * When the gap cannot be replayed (events pruned, too many missed, or an id from a
 * different database), the server sends `resync` and the client refetches.
 */
export function openStream(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  session: AuthSession,
  lastEventIdParam: string | null | undefined,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const head = (ctx.db.get<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events') as { seq: number }).seq;

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    ctx.hub.remove(sub);
    if (!res.writableEnded) res.end();
  };
  const sub = new StreamSubscriber(res, close, head);

  res.write(frameText(null, 'hello', JSON.stringify({ serverTime: ctx.clock.now(), head, user: session.user.id })));

  // Decide what to replay. Missing or empty header means a fresh client: start at head.
  let resync = false;
  let rows: { seq: number; type: string; data: string }[] = [];
  if (lastEventIdParam !== undefined && lastEventIdParam !== null && lastEventIdParam !== '') {
    const lastId = Number(lastEventIdParam);
    if (!Number.isInteger(lastId) || lastId < 0 || lastId > head) {
      resync = true;
    } else if (lastId < head) {
      const oldest = (ctx.db.get<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM events') as { seq: number | null }).seq;
      if (oldest === null || lastId + 1 < oldest) {
        resync = true;
      } else {
        rows = ctx.db.all('SELECT seq, type, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?', lastId, REPLAY_LIMIT + 1);
        if (rows.length > REPLAY_LIMIT) {
          rows = [];
          resync = true;
        }
      }
    }
  }

  if (resync) {
    sub.write(frameText(head, 'resync', JSON.stringify({ head })));
  } else {
    for (const r of rows) sub.deliver({ seq: r.seq, type: r.type, data: r.data });
  }

  // Same synchronous block as the replay above, so no event can slip in between.
  ctx.hub.add(sub);

  timer = setInterval(() => {
    // Re-check the session on every heartbeat so an expired or revoked login ends the stream.
    if (!findSession(ctx, token)) {
      close();
      return;
    }
    sub.write(frameText(null, 'ping', JSON.stringify({ serverTime: ctx.clock.now() })));
  }, ctx.config.sseHeartbeatMs);
  timer.unref();

  res.on('close', close);
  req.on('error', close);
}
