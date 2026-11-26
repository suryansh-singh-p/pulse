import { z } from "zod";

export const EventIn = z.object({
  type: z.enum(["page_view", "click", "purchase"]),
  userId: z.string().min(1),
  props: z.record(z.string(), z.unknown()).default({}),
});
export type EventIn = z.infer<typeof EventIn>;

// What the api writes to Kafka and the worker reads back: the shared contract between them.
export const StoredEvent = EventIn.extend({
  id: z.uuid(), // added by the api
  receivedAt: z.iso.datetime(), // added by the api
});
export type StoredEvent = z.infer<typeof StoredEvent>;
