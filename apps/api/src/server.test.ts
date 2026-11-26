import { afterEach, describe, expect, it } from "vitest";
import type { StoredEvent } from "@pulse/shared";
import type { Deps } from "./deps.js";
import { buildServer } from "./server.js";

let app: ReturnType<typeof buildServer>;
afterEach(() => app?.close());

/** Fakes for Kafka and Redis: no real services needed, in tests or in CI. */
function fakeDeps(overrides: Partial<Deps> = {}) {
  const published: StoredEvent[] = [];
  const deps: Deps = {
    publisher: {
      publish: async (event) => {
        published.push(event);
      },
    },
    checks: { kafka: async () => {}, redis: async () => {} },
    stats: { counts: async () => ({}) },
    ...overrides,
  };
  return { deps, published };
}

describe("api", () => {
  it("healthz and readyz return 200 when dependencies are up", async () => {
    app = buildServer(fakeDeps().deps);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
  });

  it("readyz returns 503 and names the failing dependency", async () => {
    const { deps } = fakeDeps({
      checks: {
        kafka: async () => {
          throw new Error("kafka timed out after 1000 ms");
        },
        redis: async () => {},
      },
    });
    app = buildServer(deps);
    const res = await app.inject("/readyz");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not ready",
      failed: { kafka: "kafka timed out after 1000 ms" },
    });
  });

  it("publishes a valid event and returns 202 with its id", async () => {
    const { deps, published } = fakeDeps();
    app = buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { type: "click", userId: "u1" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(body.receivedAt).toISOString()).toBe(body.receivedAt);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ id: body.id, type: "click", userId: "u1", props: {} });
  });

  it("returns 503 with Retry-After when publishing fails", async () => {
    const { deps } = fakeDeps({
      publisher: {
        publish: async () => {
          throw new Error("kafka send timed out after 3000 ms");
        },
      },
    });
    app = buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { type: "click", userId: "u1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
  });

  it("rejects an invalid event with 400 and publishes nothing", async () => {
    const { deps, published } = fakeDeps();
    app = buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { type: "nope", userId: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(published).toHaveLength(0);
  });

  it("stats returns the counts and their total", async () => {
    const { deps } = fakeDeps({ stats: { counts: async () => ({ click: 6, purchase: 2 }) } });
    app = buildServer(deps);
    const res = await app.inject("/stats");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ counts: { click: 6, purchase: 2 }, total: 8 });
  });

  it("stats returns zero before anything has been counted", async () => {
    app = buildServer(fakeDeps().deps);
    expect((await app.inject("/stats")).json()).toEqual({ counts: {}, total: 0 });
  });

  it("stats returns 503 when Redis is unavailable", async () => {
    const { deps } = fakeDeps({
      stats: {
        counts: async () => {
          throw new Error("redis timed out after 1000 ms");
        },
      },
    });
    app = buildServer(deps);
    expect((await app.inject("/stats")).statusCode).toBe(503);
  });

  it("serves the demo page at /", async () => {
    app = buildServer(fakeDeps().deps);
    const res = await app.inject("/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("<title>Pulse demo</title>");
    expect(res.body).not.toContain("%VERSION%"); // the placeholder was filled in
  });

  it("metrics include default, request and publish metrics", async () => {
    app = buildServer(fakeDeps().deps);
    await app.inject("/healthz");
    await app.inject({ method: "POST", url: "/events", payload: { type: "click", userId: "u1" } });
    const text = (await app.inject("/metrics")).body;
    expect(text).toContain("process_cpu_user_seconds_total");
    expect(text).toContain('http_requests_total{method="GET",route="/healthz",status="200"} 1');
    expect(text).toContain("http_request_duration_seconds_bucket");
    expect(text).toContain('events_published_total{result="ok"} 1');
  });
});
