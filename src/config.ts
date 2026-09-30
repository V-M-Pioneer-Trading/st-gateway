import { loadIntrospectionConfig } from "@v-m-pioneer-trading/introspection-client";

export interface GatewayConfig {
  /** Listen port. Validated here rather than parsed inline at startup. */
  port: number;
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
  /**
   * The vault secret, presented as X-Auth-Service-Secret on every agent-token
   * fetch. Not the introspection secret below: see
   * requireAuthServiceSharedSecret for why the two differ.
   */
  authServiceSharedSecret: string;
  /** How long a fetched agent token is served from cache before a normal (non-401-forced) refetch. */
  authServiceTokenCacheMs: number;
  /**
   * Where auth-service answers "what does this token carry?" (decision 21),
   * and the caller secret it expects. Used for one thing only: picking the
   * queue lane (decision 2).
   */
  introspection: IntrospectionEndpoint;
}

export interface IntrospectionEndpoint {
  /** The full endpoint URL, `/auth/v1/introspect` included. POSTed to verbatim. */
  readonly url: string;
  /** Sent as X-Introspection-Secret. */
  readonly secret: string;
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
 * For counts, where a fraction is not merely odd but breaks an invariant: the
 * retry loop runs `attempt <= maxRetries` and re-arms on `attempt <
 * maxRetries`, so a fractional bound lets it exit mid-flight without ever
 * relaying a response.
 */
const envInteger = (name: string, fallback: number, min: number): number => {
  const value = envNumber(name, fallback, min);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number >= ${min}, got "${process.env[name]}"`);
  }
  return value;
};

/**
 * Everything except the two secrets below — those get their own require*()
 * functions, same split as fleet-service's config.ts, so tests (which
 * construct a literal GatewayConfig via createApp) never need real
 * auth-service env vars just to exercise the numeric settings.
 */
export const configFromEnv = (): Omit<GatewayConfig, "introspection" | "authServiceSharedSecret"> => ({
  port: envInteger("PORT", 3002, 1),
  spaceTradersBaseUrl: process.env.SPACETRADERS_BASE_URL ?? "https://api.spacetraders.io/v2",
  rateLimitRps: envNumber("RATE_LIMIT_RPS", 2, 0.1),
  rateLimitBurst: envNumber("RATE_LIMIT_BURST", 1, 1),
  maxRetries: envInteger("MAX_RETRIES", 5, 0),
  retryBaseMs: envNumber("RETRY_BASE_MS", 500, 1),
  maxRetryDelayMs: envNumber("MAX_RETRY_DELAY_MS", 30_000, 1),
  authServiceUrl: process.env.AUTH_SERVICE_URL ?? "http://localhost:8082",
  authServiceTokenCacheMs: envNumber("AUTH_SERVICE_TOKEN_CACHE_MS", 30_000, 0),
});

/**
 * AUTH_INTROSPECTION_URL and AUTH_INTROSPECTION_SECRET, or a crash before the
 * port is bound. Neither has a default.
 *
 * Failing closed here protects no request: the lane deriver never rejects,
 * so a gateway with no center would still proxy every call — every one of
 * them in the background lane, forever, with nothing in any log to say why
 * the dashboard had become slow. A crash-loop that names the missing
 * variable is diagnosed in one line; a quiet demotion of every operator is
 * not diagnosed at all.
 *
 * Both are read straight from process.env by the shared client's own loader,
 * which also refuses a URL that is not absolute http(s) or that carries a
 * query string, and never puts the secret's value in an error message.
 *
 * The Clerk variables this service used to require (CLERK_JWT_KEY,
 * CLERK_JWT_KEY_FILE, CLERK_ISSUER) are neither read nor set anywhere since
 * meta#80 step 10 (infrastructure#92): no stack and no compose entry sets
 * them for any service but auth-service. A stray value is ignored and must
 * not stop the gateway starting: it no longer verifies anything, so it has
 * no trust anchor to hold (decision 21).
 */
export const requireIntrospection = (): IntrospectionEndpoint => {
  const { url, secret } = loadIntrospectionConfig(process.env);
  return { url, secret };
};

/**
 * AUTH_SERVICE_SHARED_SECRET, the vault secret: presented on GET
 * /auth/v1/token to fetch the SpaceTraders agent token. Required, no
 * default, for the same fail-closed reason as requireIntrospection.
 *
 * It is a different secret from AUTH_INTROSPECTION_SECRET, and the two must
 * never hold the same value. The introspection secret is held by every
 * service that asks auth-service about a token — fleet, automation,
 * navigation, agent-service and this one — because an answer only describes
 * a token the caller already holds. The vault secret is held by st-gateway
 * alone, because it hands out the credential that spends the whole system's
 * SpaceTraders account. If they were one value, any service able to
 * introspect could also withdraw the agent token and call SpaceTraders
 * around this gateway's rate budget.
 */
export const requireAuthServiceSharedSecret = (): string => {
  const secret = process.env.AUTH_SERVICE_SHARED_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("AUTH_SERVICE_SHARED_SECRET must be set");
  }
  return secret;
};

/**
 * The whole startup configuration, assembled exactly as the process does it
 * before binding the port. Exported so the startup contract — which variables
 * are required and which are ignored — is testable without spawning a process.
 */
export const gatewayConfigFromEnv = (): GatewayConfig => ({
  ...configFromEnv(),
  authServiceSharedSecret: requireAuthServiceSharedSecret(),
  introspection: requireIntrospection(),
});
