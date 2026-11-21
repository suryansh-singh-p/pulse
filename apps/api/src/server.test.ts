import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

let app: ReturnType<typeof buildServer>;
afterEach(() => app?.close());

describe("api", () => {
  it("healthz and readyz return 200", async () => {
    app = buildServer();
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
  });

  it("accepts a valid event with id and timestamp", async () => {
    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { type: "click", userId: "u1" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(body.receivedAt).toISOString()).toBe(body.receivedAt);
  });

  it("rejects an invalid event with 400", async () => {
    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { type: "nope", userId: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("stats returns an empty object", async () => {
    app = buildServer();
    expect((await app.inject("/stats")).json()).toEqual({});
  });

  it("metrics include default and request metrics", async () => {
    app = buildServer();
    await app.inject("/healthz");
    const text = (await app.inject("/metrics")).body;
    expect(text).toContain("process_cpu_user_seconds_total");
    expect(text).toContain('http_requests_total{method="GET",route="/healthz",status="200"} 1');
    expect(text).toContain("http_request_duration_seconds_bucket");
  });
});
