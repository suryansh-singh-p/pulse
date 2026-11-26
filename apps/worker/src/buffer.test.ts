import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@pulse/shared";
import { EventBuffer } from "./buffer.js";

const event = (userId: string): StoredEvent => ({
  id: "0b6e2a4e-6a43-4c3b-9d3f-2f0f4c2a1b11",
  receivedAt: "2026-11-26T10:00:00.000Z",
  type: "click",
  userId,
  props: {},
});

describe("EventBuffer", () => {
  it("commits the NEXT offset: processed up to 41 means commit 42", () => {
    const buffer = new EventBuffer();
    buffer.add(event("u1"));
    buffer.markProcessed(0, "41");
    expect(buffer.drain().offsets).toEqual([{ partition: 0, offset: "42" }]);
  });

  it("keeps the latest offset per partition", () => {
    const buffer = new EventBuffer();
    buffer.markProcessed(0, "5");
    buffer.markProcessed(2, "9");
    buffer.markProcessed(0, "7");
    expect(buffer.drain().offsets).toEqual([
      { partition: 0, offset: "8" },
      { partition: 2, offset: "10" },
    ]);
  });

  it("tracks offsets even when every message was invalid", () => {
    const buffer = new EventBuffer();
    buffer.markProcessed(1, "3");
    expect(buffer.size).toBe(0);
    expect(buffer.isEmpty).toBe(false); // still something to commit
  });

  it("drain empties the buffer", () => {
    const buffer = new EventBuffer();
    buffer.add(event("u1"));
    buffer.add(event("u2"));
    buffer.markProcessed(0, "1");
    expect(buffer.drain().events).toHaveLength(2);
    expect(buffer.size).toBe(0);
    expect(buffer.isEmpty).toBe(true);
  });

  it("handles offsets beyond Number's safe integer range", () => {
    const buffer = new EventBuffer();
    buffer.markProcessed(0, "9007199254740993"); // 2^53 + 1
    expect(buffer.drain().offsets[0]!.offset).toBe("9007199254740994");
  });
});
