import { Redis } from "ioredis";
import type { ReadinessCheck } from "./deps.js";
import { withTimeout } from "./timeout.js";

const CHECK_TIMEOUT_MS = 1_000;

export function createRedis(url: string): Redis {
  return new Redis(url, {
    // Connect explicitly at startup (await redis.connect()), not on first use.
    lazyConnect: true,
    // By default ioredis queues commands while disconnected and sends them later,
    // so a PING with Redis down would wait forever. Fail immediately instead.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
}

export function redisCheck(redis: Redis): ReadinessCheck {
  return async () => {
    await withTimeout(redis.ping(), CHECK_TIMEOUT_MS, "redis");
  };
}
