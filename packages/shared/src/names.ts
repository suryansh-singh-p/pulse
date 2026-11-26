// Names the api and the worker must agree on. A typo on one side wouldn't error:
// the worker would write one key, /stats would read another and show {}.

/** Kafka topic the api produces to and the worker consumes from. */
export const EVENTS_TOPIC = "events.raw";

/** Redis hash the worker increments (event type -> count) and /stats reads. */
export const COUNTS_KEY = "counts";
