import { describe, expect, it } from "vitest";
import type { Producer, ProducerRecord } from "kafkajs";
import { EVENTS_TOPIC, type StoredEvent } from "@pulse/shared";
import { kafkaPublisher } from "./kafka.js";

const event: StoredEvent = {
  id: "0b6e2a4e-6a43-4c3b-9d3f-2f0f4c2a1b11",
  receivedAt: "2026-11-26T10:00:00.000Z",
  type: "purchase",
  userId: "u42",
  props: { amount: 10 },
};

describe("kafkaPublisher", () => {
  it("sends to events.raw, keyed by userId, with acks=all", async () => {
    const sent: ProducerRecord[] = [];
    const producer = {
      send: async (record: ProducerRecord) => {
        sent.push(record);
        return [];
      },
    } as unknown as Producer;

    await kafkaPublisher(producer).publish(event);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.topic).toBe(EVENTS_TOPIC);
    expect(sent[0]!.acks).toBe(-1);
    expect(sent[0]!.messages).toEqual([{ key: "u42", value: JSON.stringify(event) }]);
  });

  it("rejects when Kafka doesn't answer in time", async () => {
    const producer = { send: () => new Promise(() => {}) } as unknown as Producer;
    await expect(kafkaPublisher(producer).publish(event)).rejects.toThrow(/timed out/);
  }, 10_000);
});
