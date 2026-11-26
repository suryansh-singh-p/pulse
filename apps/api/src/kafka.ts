import { Kafka, Partitioners, logLevel, type Admin, type Producer } from "kafkajs";
import type { EventPublisher, ReadinessCheck } from "./deps.js";
import { withTimeout } from "./timeout.js";

export const EVENTS_TOPIC = "events.raw";

/** Max time a POST /events waits for Kafka's ack before answering 503. */
const SEND_TIMEOUT_MS = 3_000;
/** Max time /readyz waits for Kafka. */
const CHECK_TIMEOUT_MS = 1_000;

export function createKafka(brokers: string[]): { producer: Producer; admin: Admin } {
  const kafka = new Kafka({
    clientId: "pulse-api",
    brokers,
    logLevel: logLevel.WARN,
    // Few, short retries: when Kafka is down we want a quick 503, not a 30 s hang.
    retry: { retries: 2, initialRetryTime: 200 },
  });

  const producer = kafka.producer({
    // Same murmur2 key hashing as the Java client: a key always maps to the same
    // partition, whatever client produced it. Also silences KafkaJS's startup warning.
    createPartitioner: Partitioners.DefaultPartitioner,
    // The topic is created by kafka-init; never create it with default settings.
    allowAutoTopicCreation: false,
  });

  // Used only for the readiness check: a real request to the broker.
  const admin = kafka.admin();

  return { producer, admin };
}

/** Sends each event to events.raw, keyed by userId so a user's events stay in order. */
export function kafkaPublisher(producer: Producer): EventPublisher {
  return {
    async publish(event) {
      await withTimeout(
        producer.send({
          topic: EVENTS_TOPIC,
          acks: -1, // wait until all in-sync replicas have it
          messages: [{ key: event.userId, value: JSON.stringify(event) }],
        }),
        SEND_TIMEOUT_MS,
        "kafka send",
      );
    },
  };
}

/** Ready when the broker answers a metadata request. A "connected" flag isn't enough:
 *  KafkaJS doesn't reliably report a broker that went away. */
export function kafkaCheck(admin: Admin): ReadinessCheck {
  return async () => {
    await withTimeout(admin.describeCluster(), CHECK_TIMEOUT_MS, "kafka");
  };
}
