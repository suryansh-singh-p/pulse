import { randomUUID } from "node:crypto";
import Fastify, { type FastifyServerOptions } from "fastify";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { EventIn, type StoredEvent } from "@pulse/shared";
import { demoPage } from "./demo-page.js";
import type { Deps } from "./deps.js";

export function buildServer(deps: Deps, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);

  // One registry per server, so tests can build several without duplicate-metric errors.
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requests = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const published = new Counter({
    name: "events_published_total",
    help: "Events handed to Kafka, by result",
    labelNames: ["result"],
    registers: [registry],
  });

  app.addHook("onResponse", async (req, reply) => {
    // Use the route template (e.g. /events), not the raw URL, to keep label cardinality low.
    const labels = {
      method: req.method,
      route: req.routeOptions.url ?? "unmatched",
      status: String(reply.statusCode),
    };
    requests.inc(labels);
    duration.observe(labels, reply.elapsedTime / 1000);
  });

  // Demo page. APP_VERSION is the image tag, set by the Helm chart, so the page shows
  // which release is running. Built once: it never changes while the process runs.
  const page = demoPage(process.env.APP_VERSION ?? "dev");
  app.get("/", async (_req, reply) => {
    // no-store: after a deploy, a reload shows the new version straight away.
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(page);
  });

  // Liveness: the process is up.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness: every dependency must answer. Checks run in parallel, each with its own timeout.
  app.get("/readyz", async (_req, reply) => {
    const names = Object.keys(deps.checks);
    const results = await Promise.allSettled(names.map((name) => deps.checks[name]!()));
    const failed: Record<string, string> = {};
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failed[names[i]!] = String((result.reason as Error)?.message ?? result.reason);
      }
    });
    if (Object.keys(failed).length > 0) {
      return reply.code(503).send({ status: "not ready", failed });
    }
    return { status: "ready" };
  });

  app.get("/metrics", async (_req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  app.post("/events", async (req, reply) => {
    const parsed = EventIn.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid event", issues: parsed.error.issues });
    }
    const event: StoredEvent = {
      ...parsed.data,
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
    };
    try {
      // 202 only after Kafka has acknowledged: the event is stored, not just received.
      await deps.publisher.publish(event);
    } catch (err) {
      published.inc({ result: "error" });
      req.log.error({ err, eventId: event.id }, "publish to kafka failed");
      // 503 = temporary, not the client's fault; Retry-After hints when to try again.
      return reply
        .code(503)
        .header("retry-after", "5")
        .send({ error: "event pipeline unavailable, retry later" });
    }
    published.inc({ result: "ok" });
    req.log.debug({ eventId: event.id }, "event published");
    return reply.code(202).send({ id: event.id, receivedAt: event.receivedAt });
  });

  // Counts per event type, maintained by the worker in Redis. Lags behind POST /events
  // by up to the worker's flush interval, and may over-count slightly (at-least-once).
  app.get("/stats", async (req, reply) => {
    try {
      const counts = await deps.stats.counts();
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      return { counts, total };
    } catch (err) {
      req.log.error({ err }, "reading stats failed");
      return reply.code(503).send({ error: "stats unavailable, retry later" });
    }
  });

  return app;
}
