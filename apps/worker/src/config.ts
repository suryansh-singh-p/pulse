import { z } from "zod";
import { Config } from "@pulse/shared";

// The shared settings (Kafka, Redis, S3) plus the worker's own batching knobs.
// S3 access keys are not here: the AWS SDK reads AWS_ACCESS_KEY_ID and
// AWS_SECRET_ACCESS_KEY from the environment itself (its default credential chain).
export const WorkerConfig = Config.extend({
  BATCH_SIZE: z.coerce.number().int().min(1).default(500),
  FLUSH_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

/** Validates the environment once at startup; prints every problem and exits if invalid. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const result = WorkerConfig.safeParse(cleaned);
  if (!result.success) {
    console.error("Invalid configuration:\n" + z.prettifyError(result.error));
    process.exit(1);
  }
  return result.data;
}
