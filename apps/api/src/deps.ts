import type { StoredEvent } from "@pulse/shared";

// What the HTTP server needs from the outside world. The server depends on these
// small interfaces, not on kafkajs or ioredis, so tests can pass simple fakes.

/** Durably hands an event to the pipeline; rejects if that isn't possible. */
export interface EventPublisher {
  publish(event: StoredEvent): Promise<void>;
}

/** A readiness check: resolves when the dependency is usable, rejects otherwise. */
export type ReadinessCheck = () => Promise<void>;

/** Reads the per-type event counts maintained by the worker. */
export interface StatsReader {
  counts(): Promise<Record<string, number>>;
}

export interface Deps {
  publisher: EventPublisher;
  checks: Record<string, ReadinessCheck>;
  stats: StatsReader;
}
