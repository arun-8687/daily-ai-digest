// In-process fan-out of committed events to live subscribers (SSE connections).

export interface Frame {
  seq: number;
  type: string;
  data: string;
}

export interface Subscriber {
  /** Highest event seq this subscriber has been sent (or has been replayed up to). */
  lastSent: number;
  deliver(frame: Frame): void;
}

export class Hub {
  private readonly subscribers = new Set<Subscriber>();

  add(subscriber: Subscriber): void {
    this.subscribers.add(subscriber);
  }

  remove(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
  }

  /** Synchronous. Subscribers that already have this seq (or later) are skipped. */
  publish(frame: Frame): void {
    for (const subscriber of [...this.subscribers]) {
      if (frame.seq <= subscriber.lastSent) continue;
      try {
        subscriber.deliver(frame);
        subscriber.lastSent = frame.seq;
      } catch {
        // A broken subscriber must not block the others; it is dropped and resumes via Last-Event-ID.
        this.subscribers.delete(subscriber);
      }
    }
  }

  get size(): number {
    return this.subscribers.size;
  }
}
