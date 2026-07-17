export interface GatewayConfig {
  spaceTradersBaseUrl: string;
  /** Global SpaceTraders budget, requests per second. */
  rateLimitRps: number;
  /** Bucket capacity: how many requests may dispatch back-to-back (min 1). */
  rateLimitBurst: number;
  /** Retries after the initial attempt for 429s (and 5xx/network on idempotent requests). */
  maxRetries: number;
  /** First backoff delay; doubles per retry. Retry-After wins when larger. */
  retryBaseMs: number;
  /** Ceiling on any single retry delay, whatever Retry-After demands. */
  maxRetryDelayMs: number;
}

/** A silently-mangled number here turns into an every-request hang, so bad values must fail startup. */
const envNumber = (name: string, fallback: number, min: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min}, got "${raw}"`);
  }
  return value;
};

export const configFromEnv = (): GatewayConfig => ({
  spaceTradersBaseUrl: process.env.SPACETRADERS_BASE_URL ?? "https://api.spacetraders.io/v2",
  rateLimitRps: envNumber("RATE_LIMIT_RPS", 2, 0.1),
  rateLimitBurst: envNumber("RATE_LIMIT_BURST", 1, 1),
  maxRetries: envNumber("MAX_RETRIES", 5, 0),
  retryBaseMs: envNumber("RETRY_BASE_MS", 500, 1),
  maxRetryDelayMs: envNumber("MAX_RETRY_DELAY_MS", 30_000, 1),
});
