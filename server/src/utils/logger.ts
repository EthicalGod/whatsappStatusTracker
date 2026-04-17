import pino from "pino";

// Use debug level so subscription/presence logs are visible.
// Override with LOG_LEVEL env var if needed (e.g. LOG_LEVEL=warn in prod).
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});
