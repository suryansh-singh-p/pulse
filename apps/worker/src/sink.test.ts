import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@pulse/shared";
import { objectKey, toNdjson } from "./sink.js";

describe("objectKey", () => {
  it("builds a Hive-style path from the UTC date and hour", () => {
    const key = objectKey(new Date("2026-11-26T09:05:00.000Z"), "abc");
    expect(key).toBe("raw/dt=2026-11-26/hour=09/abc.ndjson");
  });

  it("uses a new uuid per file by default", () => {
    const now = new Date();
    expect(objectKey(now)).not.toBe(objectKey(now));
  });
});

describe("toNdjson", () => {
  it("writes one JSON object per line, ending with a newline", () => {
    const events = [
      { id: "1", userId: "a" },
      { id: "2", userId: "b" },
    ] as unknown as StoredEvent[];
    const body = toNdjson(events);
    expect(body).toBe('{"id":"1","userId":"a"}\n{"id":"2","userId":"b"}\n');
    expect(body.trim().split("\n").map((line) => JSON.parse(line))).toEqual(events);
  });
});
