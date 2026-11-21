import { z } from "zod";

export const EventIn = z.object({
  type: z.enum(["page_view", "click", "purchase"]),
  userId: z.string().min(1),
  props: z.record(z.string(), z.unknown()).default({}),
});
export type EventIn = z.infer<typeof EventIn>;

export type StoredEvent = EventIn & { id: string; receivedAt: string }; // added by the api
