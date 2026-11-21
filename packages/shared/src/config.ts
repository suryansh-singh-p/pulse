import { z } from "zod";

export const Config = z.object({
  // Comma-separated host:port list, turned into an array.
  KAFKA_BROKERS: z
    .string()
    .default("localhost:9092")
    .transform((s) =>
      s
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[^:\s]+:\d+$/, "expected host:port")).min(1)),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default("redis://localhost:6379"),
  S3_ENDPOINT: z.url().optional(), // set for MinIO, unset for AWS
  S3_BUCKET: z.string().min(3).max(63).default("pulse-events"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type Config = z.infer<typeof Config>;

/**
 * Reads and validates config from the environment. Call once at app startup.
 * On invalid config it prints every problem and exits the process.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const result = Config.safeParse(cleaned);
  if (!result.success) {
    console.error("Invalid configuration:\n" + z.prettifyError(result.error));
    process.exit(1);
  }
  return result.data;
}
