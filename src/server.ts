/**
 * @file st-gateway: every SpaceTraders call in the system, through one rate
 * budget, with the one agent token injected.
 *
 * What this process decides about a caller is a queue lane, and nothing
 * else. It never decides whether a caller may make a call — that happened
 * once already, in the calling service, against the same auth-service this
 * gateway asks — so it never rejects a request for its credential, never
 * answers 401 or 403, and never fails a game call because auth-service's
 * introspection endpoint is unavailable (token-introspection.md, "What a
 * client decides for itself"). The vault is another matter: a call that needs
 * the injected agent token still answers 503 when auth-service cannot hand
 * one over.
 *
 * The lane comes from auth-service's answer about the caller's token
 * (auth-design.md decisions 2 and 21): `interactive` for an active answer
 * whose `kind` is `operator` — the dashboard's human session, forwarded
 * verbatim by agent, fleet and navigation-service — and `background` for
 * everything else: automation-service's machine token, auth-service's own
 * anonymous poll, an expired or malformed token, two Authorization lines,
 * `POST /register`'s account token, and a center that is down, slow or
 * misconfigured. The gateway never reads
 * a token itself and never looks at `sub`: knowing Clerk's subject
 * conventions is auth-service's job alone.
 */

import express from "express";
import {
  createIntrospector,
  createLaneDeriver,
  soleAuthorizationLine,
  type Introspector,
  type Lane,
} from "@v-m-pioneer-trading/clerk-client";
import type { GatewayConfig } from "./config";
import { gatewayConfigFromEnv } from "./config";
import { TokenBucket, type Priority } from "./tokenBucket";
import { createAuthTokenClient, type TokenFailure } from "./authServiceClient";

const RETRYABLE_5XX = new Set([500, 502, 503, 504]);
/** Upstream response headers worth passing back — pacing signals callers need. */
const FORWARDED_HEADERS = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];

/** Why the gateway cannot supply a credential, in words that point at the right system. */
const CREDENTIAL_UNAVAILABLE: Record<TokenFailure, string> = {
  unconfigured: "SpaceTraders credential not configured",
  unavailable: "auth-service unavailable: cannot obtain a SpaceTraders credential",
};

/**
 * The most a lane decision may add to a proxied call. A center that has not
 * answered by then yields `background`, the lane an anonymous caller gets
 * anyway, and the call proceeds.
 *
 * Not the shared client's 1000 ms default, which is sized for a decision that
 * rejects, where waiting beats a wrong answer. A lane is a guess the gateway
 * is willing to make without the center, so a hanging auth-service should
 * cost every credentialed game call a quarter of a second, not a whole one.
 * 250 ms is well above a healthy center's round trip on the same host.
 */
export const LANE_TIMEOUT_MS = 250;

/**
 * How often, at most, a failing center is reported. A lane that falls back to
 * `background` is invisible from the outside: a rotated introspection
 * secret or a URL with a stray trailing slash quietly demotes every operator,
 * and nothing else in the system would say so. One line a minute says so
 * without letting a flood of credentialed calls flood the log.
 */
export const CENTER_WARNING_INTERVAL_MS = 60_000;

/**
 * The introspector the lane deriver asks, wrapped so that an `unavailable`
 * answer is noticed. The answer itself passes through untouched, and the
 * warning names only where the center is — origin and path, never the
 * token, the secret or any userinfo in the URL — because the client
 * deliberately does not say which of its five failure modes it hit.
 */
function reportingUnavailable(inner: Introspector, url: string, warn: (line: string) => void): Introspector {
  const parsed = new URL(url);
  const where = `${parsed.origin}${parsed.pathname}`;
  let lastWarnedAt = -Infinity;
  let suppressed = 0;
  return {
    async introspect(token) {
      const answer = await inner.introspect(token);
      if (answer.state === "unavailable") {
        const now = Date.now();
        if (now - lastWarnedAt >= CENTER_WARNING_INTERVAL_MS) {
          const more = suppressed > 0 ? ` (${String(suppressed)} more since the last warning)` : "";
          warn(
            `st-gateway: auth-service introspection at ${where} is unavailable — unreachable, slow, non-2xx, ` +
              `unreadable, or refusing AUTH_INTROSPECTION_SECRET; operators are queued as background${more}`,
          );
          lastWarnedAt = now;
          suppressed = 0;
        } else {
          suppressed += 1;
        }
      }
      return answer;
    },
  };
}

/**
 * The shared client's lanes are this gateway's queue classes, one for one.
 * Spelled out rather than cast so that a change to either union — a third
 * queue here, a third lane there — is a compile error at this line instead
 * of a lane silently landing in a queue that does not exist.
 */
const PRIORITY_FOR_LANE: Record<Lane, Priority> = {
  interactive: "interactive",
  background: "background",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The caller gave up (timeout, abort). The socket is the signal — req.destroyed
 * is true for any fully-consumed body stream (Node autoDestroy), not just
 * disconnects.
 */
const clientGoneAway = (res: express.Response): boolean => res.socket === null || res.socket.destroyed;

/**
 * What to do with the Authorization header on an upstream call.
 *
 * - `none` — `GET /` is the one SpaceTraders endpoint that needs no
 *   credential. Not injecting here is what lets auth-service poll it
 *   *through* st-gateway like every other caller; injecting would have
 *   st-gateway asking auth-service for a token to make the very call that
 *   refreshes that token, a cycle for no reason.
 * - `forward` — `POST /register` inverts the rule: it authenticates with the
 *   *account* token, which only auth-service holds and which this gateway
 *   never sees otherwise, so the caller's own header is passed through
 *   verbatim. Injecting here would deadlock the system in both directions —
 *   registration would carry the agent token and fail, and while auth-service
 *   is UNCONFIGURED there is no agent token at all, so the call would 503,
 *   making it impossible to ever leave UNCONFIGURED or to recover
 *   automatically after an observed wipe (decision 7).
 * - `inject` — everything else (decision 5).
 *
 * Matched on the path, never the raw URL: `POST /register?trace=1` is still
 * registration.
 */
export type CredentialMode = "none" | "forward" | "inject";

export const credentialModeFor = (method: string, path: string): CredentialMode => {
  if (method === "GET" && path === "/") return "none";
  if (method === "POST" && path === "/register") return "forward";
  return "inject";
};

function retryDelayMs(attempt: number, config: GatewayConfig, retryAfterHeader: string | null): number {
  const backoff = config.retryBaseMs * 2 ** attempt;
  let retryAfterMs = 0;
  if (retryAfterHeader !== null) {
    const seconds = Number(retryAfterHeader);
    retryAfterMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Math.max(0, Date.parse(retryAfterHeader) - Date.now());
    if (Number.isNaN(retryAfterMs)) retryAfterMs = 0;
  }
  return Math.min(Math.max(backoff, retryAfterMs), config.maxRetryDelayMs);
}

export function createApp(config: GatewayConfig) {
  const app = express();
  const bucket = new TokenBucket(config.rateLimitRps, config.rateLimitBurst);
  const authTokenClient = createAuthTokenClient({
    authServiceUrl: config.authServiceUrl,
    authServiceSharedSecret: config.authServiceSharedSecret,
    cacheTtlMs: config.authServiceTokenCacheMs,
  });
  const laneDeriver = createLaneDeriver(
    reportingUnavailable(
      createIntrospector({
        url: config.introspection.url,
        secret: config.introspection.secret,
        timeoutMs: LANE_TIMEOUT_MS,
      }),
      config.introspection.url,
      (line) => { console.warn(line); },
    ),
  );

  const health = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok" });
  };
  app.get("/health", health);
  app.get("/api/st-gateway/health", health);

  app.get("/metrics", (_req, res) => {
    res.json({ queues: bucket.getMetrics() });
  });

  async function proxy(req: express.Request, res: express.Response) {
    const url = `${config.spaceTradersBaseUrl}${req.url}`;
    const hasBody = Buffer.isBuffer(req.body) && req.body.length > 0;
    const headers: Record<string, string> = {};
    if (hasBody) headers["Content-Type"] = req.headers["content-type"] ?? "application/json";

    const mode = credentialModeFor(req.method, req.path);

    // A 429 means SpaceTraders did NOT execute the request, so it is always safe
    // to retry. 5xx/network failures may have executed a mutation upstream, so
    // those are only retried for methods without side effects — at-most-once for
    // POSTs (purchases, sells) is worth more than a transparent retry.
    const sideEffectFree = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    // The lane, once per inbound request and never per attempt: retries
    // below reuse it, so one proxied call asks auth-service at most once.
    // derive() never rejects and never throws, and is bounded by
    // LANE_TIMEOUT_MS. soleAuthorizationLine, not req.header(): Node keeps
    // the first of two Authorization lines and drops the second, and a
    // caller who sent two must not get to choose which one picks the lane.
    // No line, several lines, or a malformed one is `background` with no
    // call to the center, so anonymous traffic never waits on auth-service.
    // X-Priority is not read: a lane is derived, never declared.
    //
    // POST /register carries the caller's SpaceTraders *account* token, not a
    // session: asking auth-service about it spends a round trip to learn
    // nothing, and sends a SpaceTraders credential somewhere it has no
    // business going. Registration is background, and the header is still
    // forwarded byte for byte below.
    const priority: Priority =
      mode === "forward" ? "background" : PRIORITY_FOR_LANE[await laneDeriver.derive(soleAuthorizationLine(req))];

    if (mode === "forward") {
      const forwarded = req.header("Authorization");
      if (forwarded !== undefined) headers.Authorization = forwarded;
    } else if (mode === "inject") {
      const result = await authTokenClient.getToken();
      if (result.token === null) {
        res.status(503).json({ error: { message: CREDENTIAL_UNAVAILABLE[result.reason] } });
        return;
      }
      headers.Authorization = `Bearer ${result.token}`;
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (clientGoneAway(res)) return;

      await bucket.acquire(priority);
      // Checked again on the way out of the queue: the wait is where a caller
      // is most likely to give up, and a token spent on an abandoned request
      // should at least not also cost SpaceTraders an upstream call.
      if (clientGoneAway(res)) return;

      let upstream: Response | null = null;
      try {
        upstream = await fetch(url, {
          method: req.method,
          headers,
          body: hasBody ? (req.body as BodyInit) : undefined,
        });
      } catch (err) {
        lastError = err;
      }

      // A 401 here means the injected token itself was rejected — decision
      // 7's "a 401 forces an immediate, out-of-cycle poll", not a rate/5xx
      // condition. Safe to retry regardless of method: SpaceTraders rejects
      // bad auth before any mutation logic runs, so no side effect occurred.
      // Only in `inject` mode: on registration a 401 means the *caller's*
      // account token was rejected, which refetching our agent token would
      // neither explain nor fix.
      const isAuthFailure = mode === "inject" && upstream !== null && upstream.status === 401;
      const retryable =
        upstream === null
          ? sideEffectFree
          : upstream.status === 429 || isAuthFailure || (sideEffectFree && RETRYABLE_5XX.has(upstream.status));
      const mayRetry = retryable && attempt < config.maxRetries;

      if (mayRetry && isAuthFailure) {
        const refreshed = await authTokenClient.refreshAfterUnauthorized();
        const authorization = refreshed.token === null ? null : `Bearer ${refreshed.token}`;
        // Only worth another attempt if auth-service actually produced a
        // *different* credential. Re-sending the one SpaceTraders just
        // rejected spends the shared budget to reach the same 401, and used
        // to do so MAX_RETRIES times back-to-back with no backoff at all.
        if (authorization !== null && authorization !== headers.Authorization) {
          headers.Authorization = authorization;
          // Release the pooled connection before abandoning this response.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- isAuthFailure is only true when upstream !== null (checked above); TypeScript cannot narrow a `let` through the aliased condition
          await upstream!.body?.cancel();
          continue; // immediately: a stale credential needs a token, not a delay
        }
        // Otherwise fall through and relay the 401 with its upstream body.
      } else if (mayRetry) {
        if (upstream !== null) await upstream.body?.cancel();
        await sleep(retryDelayMs(attempt, config, upstream?.headers.get("retry-after") ?? null));
        continue;
      }

      if (upstream === null) break;

      const text = await upstream.text();
      for (const name of FORWARDED_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      res
        .status(upstream.status)
        .type(upstream.headers.get("content-type") ?? "application/json")
        .send(text);
      return;
    }

    res.status(502).json({
      error: { message: `SpaceTraders unreachable: ${String(lastError)}` },
    });
  }

  // Raw body: the gateway forwards payloads verbatim and never parses them.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Express 4 ignores the returned promise; the handler catches every rejection itself (see the catch below)
  app.use("/proxy", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
    try {
      await proxy(req, res);
    } catch (err) {
      // Express 4 does not observe rejections from async handlers. Anything
      // that threw past `proxy` — an upstream body that died mid-read is the
      // realistic one — used to surface as an unhandled rejection while the
      // caller's socket stayed open forever, with no status and no log line.
      console.error("st-gateway: proxy request failed", err);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(502).json({ error: { message: `SpaceTraders proxy failed: ${String(err)}` } });
    }
  });

  // Keep parser failures (payload too large, aborted stream) in the same JSON
  // error envelope as everything else instead of Express's default HTML page.
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(typeof err.status === "number" ? err.status : 500).json({
      error: { message: err.message || "internal error" },
    });
  });

  return app;
}

if (require.main === module) {
  // Throws, before the port is bound, on a bad number or a missing
  // AUTH_SERVICE_SHARED_SECRET, AUTH_INTROSPECTION_URL or
  // AUTH_INTROSPECTION_SECRET. Any CLERK_* variables still in the
  // environment are ignored.
  const config: GatewayConfig = gatewayConfigFromEnv();
  createApp(config).listen(config.port, () => {
    console.log(`st-gateway listening on http://localhost:${String(config.port)}`);
  });
}
