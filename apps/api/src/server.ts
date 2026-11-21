import { randomUUID } from "node:crypto";
import Fastify, { type FastifyServerOptions } from "fastify";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { EventIn, type StoredEvent } from "@pulse/shared";

export function buildServer(opts: FastifyServerOptions = {}) {
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

  // Liveness: the process is up.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness: TODO check Redis and Kafka.
  app.get("/readyz", async () => ({ status: "ready" }));

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
    // TODO: produce to Kafka. Stubbed for now.
    req.log.info({ event }, "event accepted");
    return reply.code(202).send({ id: event.id, receivedAt: event.receivedAt });
  });

  // TODO: real stats.
  app.get("/stats", async () => ({}));

  return app;
}
