/**
 * Rejects if `promise` hasn't settled within `ms`. The original promise keeps running
 * (it can't be cancelled), but its result is ignored, and a later rejection is handled
 * by Promise.race, so it can't crash the process as an unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
