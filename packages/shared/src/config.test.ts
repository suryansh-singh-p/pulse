import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./index.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({})).toEqual({
      KAFKA_BROKERS: ["localhost:9092"],
      REDIS_URL: "redis://localhost:6379",
      S3_BUCKET: "pulse-events",
      PORT: 3000,
    });
  });

  it("parses provided values", () => {
    const c = loadConfig({
      PORT: "8080",
      KAFKA_BROKERS: "k1:9092, k2:9092",
      S3_ENDPOINT: "http://minio:9000",
    });
    expect(c.PORT).toBe(8080);
    expect(c.KAFKA_BROKERS).toEqual(["k1:9092", "k2:9092"]);
    expect(c.S3_ENDPOINT).toBe("http://minio:9000");
  });

  it("exits on invalid config", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadConfig({ PORT: "abc", REDIS_URL: "http://x" })).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls[0]?.[0]).toContain("PORT");
    exit.mockRestore();
    err.mockRestore();
  });
});
