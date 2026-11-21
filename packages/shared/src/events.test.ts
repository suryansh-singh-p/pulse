import { expect, it } from "vitest";
import { EventIn } from "./events.js";

it("accepts a valid event and rejects one without userId", () => {
  expect(EventIn.safeParse({ type: "click", userId: "u1" }).success).toBe(true);

  const missing = EventIn.safeParse({ type: "click" });
  expect(missing.success).toBe(false);
  expect(missing.error?.issues[0]?.path).toEqual(["userId"]);
});
