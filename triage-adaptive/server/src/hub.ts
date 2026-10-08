/** One committed event, as published to live subscribers. data is the JSON payload string. */
export interface Frame {
  seq: number;
  type: string;
  data: string;
}

/**
 * A live subscriber (an SSE connection in the HTTP layer).
 *
 * CONTRACT for the HTTP layer: Hub.publish only calls deliver for frames with
 * seq > lastSent. deliver() MUST set lastSent = frame.seq (Hub also raises it
 * after a successful deliver, so a forgotten update cannot cause duplicates).
 */
export interface Subscriber {
  lastSent: number;
  deliver(frame: Frame): void;
}

export class Hub {
  private readonly subscribers = new Set<Subscriber>();

  add(s: Subscriber): void {
    this.subscribers.add(s);
  }

  remove(s: Subscriber): void {
    this.subscribers.delete(s);
  }

  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Delivers a committed frame to every subscriber that has not seen it yet.
   * A subscriber whose deliver() throws is removed and the others still receive the frame.
   */
  publish(frame: Frame): void {
    for (const s of [...this.subscribers]) {
      if (s.lastSent >= frame.seq) continue;
      try {
        s.deliver(frame);
        if (s.lastSent < frame.seq) s.lastSent = frame.seq;
      } catch {
        this.subscribers.delete(s);
      }
    }
  }
}
