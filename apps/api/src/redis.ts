import { Redis } from "ioredis";
import { COUNTS_KEY } from "@pulse/shared";
import type { ReadinessCheck, StatsReader } from "./deps.js";
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

/** Counts written by the worker. Redis returns strings ({ click: "6" }); the API returns numbers. */
export function redisStats(redis: Redis): StatsReader {
  return {
    async counts() {
      const raw = await withTimeout(redis.hgetall(COUNTS_KEY), CHECK_TIMEOUT_MS, "redis");
      return Object.fromEntries(Object.entries(raw).map(([type, n]) => [type, Number(n)]));
    },
  };
}
