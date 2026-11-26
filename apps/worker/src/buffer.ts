import type { StoredEvent } from "@pulse/shared";

export interface PartitionOffset {
  partition: number;
  /** The NEXT offset to read: Kafka's commit means "done with everything before this". */
  offset: string;
}

/**
 * Events waiting to be written to S3, plus how far each partition has been processed.
 * Offsets are tracked for every message, including invalid (skipped) ones, so the
 * commit moves past them too.
 */
export class EventBuffer {
  private events: StoredEvent[] = [];
  private nextOffsets = new Map<number, string>();

  get size(): number {
    return this.events.length;
  }

  /** True if there is anything to write or commit. */
  get isEmpty(): boolean {
    return this.events.length === 0 && this.nextOffsets.size === 0;
  }

  add(event: StoredEvent): void {
    this.events.push(event);
  }

  /** Records that a partition has been processed up to and including `offset`. */
  markProcessed(partition: number, offset: string): void {
    // Offsets are 64-bit; strings + BigInt avoid losing precision past 2^53.
    this.nextOffsets.set(partition, (BigInt(offset) + 1n).toString());
  }

  /** Takes everything out, leaving the buffer empty for new messages. */
  drain(): { events: StoredEvent[]; offsets: PartitionOffset[] } {
    const events = this.events;
    const offsets = [...this.nextOffsets].map(([partition, offset]) => ({ partition, offset }));
    this.events = [];
    this.nextOffsets = new Map();
    return { events, offsets };
  }
}
