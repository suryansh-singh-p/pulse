import { setTimeout as sleep } from "node:timers/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import { Kafka, logLevel, type EachBatchPayload } from "kafkajs";
import { pino } from "pino";
import { COUNTS_KEY, EVENTS_TOPIC } from "@pulse/shared";
import { EventBuffer } from "./buffer.js";
import { loadWorkerConfig } from "./config.js";
import { countByType, parseEvent } from "./parse.js";
import { s3Sink } from "./sink.js";

const GROUP_ID = "pulse-worker";
const WRITE_ATTEMPTS = 3;
const SHUTDOWN_TIMEOUT_MS = 20_000; // below Compose's stop_grace_period (30 s)

const config = loadWorkerConfig();
const log = pino({ base: { service: "pulse-worker" } });

const kafka = new Kafka({
  clientId: "pulse-worker",
  brokers: config.KAFKA_BROKERS,
  logLevel: logLevel.WARN,
});
const consumer = kafka.consumer({ groupId: GROUP_ID, allowAutoTopicCreation: false });

const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false, // fail fast instead of queueing while disconnected
  maxRetriesPerRequest: 1,
});
redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));

// endpoint set = MinIO, which needs path-style URLs (http://minio:9000/<bucket>/<key>).
// Credentials and region come from the environment (the SDK's default chain).
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: Boolean(config.S3_ENDPOINT),
});
const sink = s3Sink(s3, config.S3_BUCKET);
const buffer = new EventBuffer();

/**
 * Exits without committing. The platform restarts the worker, and Kafka redelivers
 * everything after the last commit: nothing is lost, some events may be processed twice.
 */
function fatal(err: unknown, msg: string): never {
  log.fatal({ err }, msg);
  process.exit(1);
}

// Flushes run one at a time. Two overlapping flushes could commit out of order and
// move a partition's committed offset backwards.
let flushChain: Promise<void> = Promise.resolve();
function flush(reason: string): Promise<void> {
  flushChain = flushChain.then(() => doFlush(reason));
  return flushChain;
}

async function doFlush(reason: string): Promise<void> {
  if (buffer.isEmpty) return;
  const { events, offsets } = buffer.drain();

  // 1. Write the file. Only a successful write may lead to a commit.
  if (events.length > 0) {
    for (let attempt = 1; ; attempt++) {
      try {
        const key = await sink.write(events);
        log.info({ key, events: events.length, reason }, "flushed to s3");
        break;
      } catch (err) {
        if (attempt >= WRITE_ATTEMPTS) fatal(err, "s3 write failed; exiting without committing");
        log.warn({ err, attempt }, "s3 write failed, retrying");
        await sleep(1_000 * attempt);
      }
    }
  }

  // 2. Commit: "this group is done with everything before these offsets".
  try {
    await consumer.commitOffsets(offsets.map((o) => ({ topic: EVENTS_TOPIC, ...o })));
    log.debug({ offsets }, "offsets committed");
  } catch (err) {
    // The file is already written. If the commit fails (e.g. a rebalance moved the
    // partition to another worker), these events will be delivered again: a duplicate,
    // never a loss.
    log.warn({ err, offsets }, "offset commit failed; events may be redelivered");
  }
}

async function handleBatch({ batch, heartbeat }: EachBatchPayload): Promise<void> {
  try {
    // 1. Validate. Invalid messages are skipped (no dead-letter queue in this scope).
    const valid = [];
    for (const message of batch.messages) {
      const event = parseEvent(message.value);
      if (event) valid.push(event);
      else log.warn({ partition: batch.partition, offset: message.offset }, "skipping invalid event");
    }

    // 2. Count per type: one round trip to Redis for the whole batch.
    const counts = countByType(valid);
    if (counts.size > 0) {
      const pipeline = redis.pipeline();
      for (const [type, n] of counts) pipeline.hincrby(COUNTS_KEY, type, n);
      const results = await pipeline.exec();
      const failed = results?.find(([err]) => err);
      if (failed) throw failed[0];
    }

    // 3. Buffer, and remember how far this partition got (including skipped messages).
    for (const event of valid) buffer.add(event);
    const last = batch.messages.at(-1);
    if (last) buffer.markProcessed(batch.partition, last.offset);
  } catch (err) {
    fatal(err, "batch processing failed; exiting without committing");
  }

  // 4. Size trigger. Awaiting here pauses consumption while writing (back-pressure).
  if (buffer.size >= config.BATCH_SIZE) await flush("size");
  await heartbeat(); // tell the group we're alive after possibly slow work
}

// Time trigger: on a quiet day, events still reach S3 within FLUSH_INTERVAL_MS.
const timer = setInterval(() => void flush("interval"), config.FLUSH_INTERVAL_MS);

let inFlight: Promise<void> | undefined;

// KafkaJS would restart a crashed consumer by itself, refetching from the last commit
// while old events are still buffered (duplicates within one file). Restart cleanly instead.
consumer.on(consumer.events.CRASH, ({ payload }) => fatal(payload.error, "consumer crashed"));

try {
  await Promise.all([consumer.connect(), redis.connect()]);
  // fromBeginning applies only when the group has no committed offset yet.
  await consumer.subscribe({ topic: EVENTS_TOPIC, fromBeginning: true });
  await consumer.run({
    autoCommit: false, // we commit after the S3 write, never before
    eachBatch: async (payload) => {
      const work = handleBatch(payload);
      inFlight = work;
      await work;
    },
  });
  log.info(
    { group: GROUP_ID, topic: EVENTS_TOPIC, batchSize: config.BATCH_SIZE, flushMs: config.FLUSH_INTERVAL_MS },
    "worker started",
  );
} catch (err) {
  fatal(err, "startup failed");
}

// Shutdown: stop taking work, write and commit what's buffered (commits are only
// possible before disconnecting), then leave the group so partitions move immediately.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  setTimeout(() => fatal(new Error("timeout"), "shutdown timed out"), SHUTDOWN_TIMEOUT_MS).unref();

  clearInterval(timer);
  consumer.pause([{ topic: EVENTS_TOPIC }]);
  await inFlight;
  await flush("shutdown");
  await consumer.disconnect();
  await redis.quit();
  log.info("stopped cleanly");
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}
