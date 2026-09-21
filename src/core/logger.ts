import pino from "pino";

const REDACTED = "[REDACTED]";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "accessToken",
  "access_token",
  "refreshToken",
  "password",
  "passwordHash",
  "token",
  "apiKey",
  "api_key",
  "encryptedCredentials",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  redact: { paths: redactPaths, censor: REDACTED },
  base: { service: "ai-commerce-response-engine" },
});

export function childLogger(scope: string, bindings: Record<string, unknown> = {}) {
  return logger.child({ scope, ...bindings });
}
