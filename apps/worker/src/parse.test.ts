import { describe, expect, it } from "vitest";
import { countByType, parseEvent } from "./parse.js";

const valid = {
  id: "0b6e2a4e-6a43-4c3b-9d3f-2f0f4c2a1b11",
  receivedAt: "2026-11-26T10:00:00.000Z",
  type: "purchase",
  userId: "u1",
  props: { amount: 10 },
};
const buf = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v));

describe("parseEvent", () => {
  it("returns the event for a valid message", () => {
    expect(parseEvent(buf(valid))).toEqual(valid);
  });

  it("returns null for non-JSON, a null value, or a schema violation", () => {
    expect(parseEvent(buf("not json"))).toBeNull();
    expect(parseEvent(null)).toBeNull();
    expect(parseEvent(buf({ ...valid, type: "unknown" }))).toBeNull();
    expect(parseEvent(buf({ ...valid, id: undefined }))).toBeNull(); // the api always adds an id
  });
});

describe("countByType", () => {
  it("counts events per type", () => {
    const e = (type: "click" | "purchase") => ({ ...valid, type });
    expect(Object.fromEntries(countByType([e("click"), e("purchase"), e("click")]))).toEqual({
      click: 2,
      purchase: 1,
    });
  });
});
