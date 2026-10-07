// In-process fan-out for live events. Publishing happens only after a transaction
// commits, so subscribers never see an event that was rolled back.

export interface Frame {
  seq: number;
  type: string;
  /** JSON payload. Never contains raw newlines, so it is safe in an SSE `data:` line. */
  data: string;
}

export interface Subscriber {
  /** Highest seq this subscriber has been sent. Frames at or below it are skipped. */
  lastSent: number;
  deliver(frame: Frame): void;
}

export class Hub {
  private readonly subscribers = new Set<Subscriber>();

  add(sub: Subscriber): void {
    this.subscribers.add(sub);
  }

  remove(sub: Subscriber): void {
    this.subscribers.delete(sub);
  }

  get size(): number {
    return this.subscribers.size;
  }

  publish(frame: Frame): void {
    for (const sub of this.subscribers) {
      if (frame.seq > sub.lastSent) sub.deliver(frame);
    }
  }
}
