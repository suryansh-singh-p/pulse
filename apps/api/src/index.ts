import { loadConfig } from "@pulse/shared";
import { createKafka, kafkaCheck, kafkaPublisher } from "./kafka.js";
import { createRedis, redisCheck } from "./redis.js";
import { buildServer } from "./server.js";

const config = loadConfig();

// One producer and one Redis client for the whole process, created once at startup.
const { producer, admin } = createKafka(config.KAFKA_BROKERS);
const redis = createRedis(config.REDIS_URL);

const app = buildServer(
  {
    publisher: kafkaPublisher(producer),
    checks: { kafka: kafkaCheck(admin), redis: redisCheck(redis) },
  },
  { logger: true },
);

// ioredis emits "error" on every failed reconnect; log it instead of crashing.
redis.on("error", (err) => app.log.warn({ err: err.message }, "redis error"));

try {
  // Connect before accepting traffic. If a dependency is unreachable, exit non-zero
  // and let the orchestrator (Compose restart policy, Kubernetes) restart us.
  await Promise.all([producer.connect(), admin.connect(), redis.connect()]);
  app.log.info({ brokers: config.KAFKA_BROKERS }, "connected to kafka and redis");
  await app.listen({ host: "0.0.0.0", port: config.PORT });
} catch (err) {
  app.log.error(err, "startup failed");
  process.exit(1);
}

// Graceful shutdown, in reverse order of use:
// 1. stop accepting requests and let in-flight ones finish (their Kafka sends complete),
// 2. disconnect the producer (flushes anything still buffered), 3. close Redis.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function shutdown(signal: NodeJS.Signals) {
  app.log.info({ signal }, "shutting down");
  // Force exit if something hangs (e.g. a stuck keep-alive connection).
  setTimeout(() => {
    app.log.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await app.close();
    app.log.info("server closed");
    await producer.disconnect();
    await admin.disconnect();
    app.log.info("kafka disconnected");
    await redis.quit();
    app.log.info("redis closed");
    process.exit(0);
  } catch (err) {
    app.log.error(err, "error during shutdown");
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}
