import { StoredEvent } from "@pulse/shared";

/** Parses a Kafka message value into an event, or returns null if it isn't a valid one. */
export function parseEvent(value: Buffer | null): StoredEvent | null {
  if (!value) return null;
  try {
    const result = StoredEvent.safeParse(JSON.parse(value.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null; // not JSON at all
  }
}

/** Counts events per type, so one batch becomes a few HINCRBY commands, not one per event. */
export function countByType(events: StoredEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return counts;
}
