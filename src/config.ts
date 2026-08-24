import { readFileSync } from "fs";

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
  /** auth-service base URL (decision 5) — GET /auth/v1/token is fetched from here. */
  authServiceUrl: string;
  /** Shared secret presented as X-Auth-Service-Secret on every token fetch. */
  authServiceSharedSecret: string;
  /** How long a fetched agent token is served from cache before a normal (non-401-forced) refetch. */
  authServiceTokenCacheMs: number;
  /** Clerk's RS256 public key (PEM/SPKI) — decision 2's priority derivation. */
  clerkJwtKeyPem: string;
  clerkIssuer: string | null;
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

/**
 * Everything except the two secrets below — those get their own require*()
 * functions, same split as fleet-service's config.ts, so tests (which
 * construct a literal GatewayConfig via createApp) never need real Clerk or
 * auth-service env vars just to exercise the numeric settings.
 */
export const configFromEnv = (): Omit<GatewayConfig, "clerkJwtKeyPem" | "authServiceSharedSecret"> => ({
  spaceTradersBaseUrl: process.env.SPACETRADERS_BASE_URL ?? "https://api.spacetraders.io/v2",
  rateLimitRps: envNumber("RATE_LIMIT_RPS", 2, 0.1),
  rateLimitBurst: envNumber("RATE_LIMIT_BURST", 1, 1),
  maxRetries: envNumber("MAX_RETRIES", 5, 0),
  retryBaseMs: envNumber("RETRY_BASE_MS", 500, 1),
  maxRetryDelayMs: envNumber("MAX_RETRY_DELAY_MS", 30_000, 1),
  authServiceUrl: process.env.AUTH_SERVICE_URL ?? "http://localhost:8082",
  authServiceTokenCacheMs: envNumber("AUTH_SERVICE_TOKEN_CACHE_MS", 30_000, 0),
  clerkIssuer: process.env.CLERK_ISSUER ?? null,
});

/**
 * Clerk's public key comes either inline (CLERK_JWT_KEY, how production
 * passes it from SSM through the bootstrap script) or as a path
 * (CLERK_JWT_KEY_FILE, how compose mounts the local dev key). Neither has a
 * default — a service that can start without a trust anchor is one that can
 * be deployed with authentication silently off. See fleet-service/config.ts
 * for the identical pattern this was ported from.
 */
export const requireClerkJwtKey = (): string => {
  const inline = process.env.CLERK_JWT_KEY;
  if (inline !== undefined && inline !== "") {
    return inline.replace(/\\n/g, "\n");
  }

  const path = process.env.CLERK_JWT_KEY_FILE;
  if (path !== undefined && path !== "") {
    const pem = readFileSync(path, "utf8").trim();
    if (pem === "") throw new Error(`CLERK_JWT_KEY_FILE (${path}) is empty`);
    return pem;
  }

  throw new Error("CLERK_JWT_KEY or CLERK_JWT_KEY_FILE must be set");
};

/** Same "fail closed at startup" reasoning as requireClerkJwtKey. */
export const requireAuthServiceSharedSecret = (): string => {
  const secret = process.env.AUTH_SERVICE_SHARED_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("AUTH_SERVICE_SHARED_SECRET must be set");
  }
  return secret;
};
