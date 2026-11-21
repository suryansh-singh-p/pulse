import { loadConfig } from "@pulse/shared";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = buildServer({ logger: true });

try {
  await app.listen({ host: "0.0.0.0", port: config.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown: stop accepting connections, let in-flight requests finish, then exit.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function shutdown(signal: NodeJS.Signals) {
  app.log.info({ signal }, "shutting down");
  // Force exit if close hangs (e.g. a stuck keep-alive connection).
  setTimeout(() => {
    app.log.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await app.close();
    app.log.info("server closed");
    process.exit(0);
  } catch (err) {
    app.log.error(err, "error during shutdown");
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}
