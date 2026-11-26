import { randomUUID } from "node:crypto";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { StoredEvent } from "@pulse/shared";

/**
 * Hive-style path, so query engines can skip folders by date and hour:
 *   raw/dt=2026-11-26/hour=10/<uuid>.ndjson
 * Partitioned by write time (UTC). The uuid means two workers, or a redelivery,
 * never overwrite each other's files.
 */
export function objectKey(now: Date, id: string = randomUUID()): string {
  const iso = now.toISOString(); // e.g. 2026-11-26T10:15:00.000Z
  return `raw/dt=${iso.slice(0, 10)}/hour=${iso.slice(11, 13)}/${id}.ndjson`;
}

/** Newline-delimited JSON: one event per line, ending with a newline. */
export function toNdjson(events: StoredEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

export interface Sink {
  /** Writes the events as one file and returns its key; rejects if the write failed. */
  write(events: StoredEvent[]): Promise<string>;
}

export function s3Sink(client: S3Client, bucket: string): Sink {
  return {
    async write(events) {
      const key = objectKey(new Date());
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: toNdjson(events),
          ContentType: "application/x-ndjson",
        }),
      );
      return key;
    },
  };
}
