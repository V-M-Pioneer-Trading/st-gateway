import express from "express";
import { GatewayConfig, configFromEnv, requireAuthServiceSharedSecret, requireClerkJwtKey } from "./config";
import { TokenBucket } from "./tokenBucket";
import { createAuthTokenClient } from "./authServiceClient";
import { createPriorityDeriver } from "./auth";

const RETRYABLE_5XX = new Set([500, 502, 503, 504]);
/** Upstream response headers worth passing back — pacing signals callers need. */
const FORWARDED_HEADERS = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const priorityDeriver = createPriorityDeriver({
    clerkJwtKeyPem: config.clerkJwtKeyPem,
    clerkIssuer: config.clerkIssuer,
  });

  const health = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok" });
  };
  app.get("/health", health);
  app.get("/api/st-gateway/health", health);

  app.get("/metrics", (_req, res) => {
    res.json({ queues: bucket.getMetrics() });
  });

  // Raw body: the gateway forwards payloads verbatim and never parses them.
  app.use("/proxy", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
    const url = `${config.spaceTradersBaseUrl}${req.url}`;
    const hasBody = Buffer.isBuffer(req.body) && req.body.length > 0;
    const headers: Record<string, string> = {};
    if (hasBody) headers["Content-Type"] = req.headers["content-type"] ?? "application/json";

    // decision 5: GET / is the one SpaceTraders endpoint that needs no
    // credential. Not injecting here is what lets auth-service poll it
    // *through* st-gateway like every other caller — injecting would have
    // st-gateway asking auth-service for a token to make the very call that
    // refreshes that token, a cycle for no reason.
    const isUnauthenticatedRoot = req.method === "GET" && req.url === "/";

    // A 429 means SpaceTraders did NOT execute the request, so it is always safe
    // to retry. 5xx/network failures may have executed a mutation upstream, so
    // those are only retried for methods without side effects — at-most-once for
    // POSTs (purchases, sells) is worth more than a transparent retry.
    const sideEffectFree = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    // decision 2: priority comes from a verified Clerk identity, never a
    // client-supplied header — see auth.ts for what "verified" resolves to
    // and the known interim gap (every caller degrades to background until
    // increment 3 Stage 5 forwards a real Clerk token here).
    const priority = await priorityDeriver.derive(req.header("Authorization"));

    if (!isUnauthenticatedRoot) {
      const token = await authTokenClient.getToken();
      if (token === null) {
        res.status(503).json({ error: { message: "SpaceTraders credential not configured" } });
        return;
      }
      headers.Authorization = `Bearer ${token}`;
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      // Client gave up (timeout, abort): stop spending the shared budget on it.
      // The socket is the signal — req.destroyed is true for any fully-consumed
      // body stream (Node autoDestroy), not just disconnects.
      if (res.socket === null || res.socket.destroyed) return;

      await bucket.acquire(priority);
      let upstream: Response | null = null;
      try {
        upstream = await fetch(url, {
          method: req.method,
          headers,
          body: hasBody ? req.body : undefined,
        });
      } catch (err) {
        lastError = err;
      }

      // A 401 here means the injected token itself was rejected — decision
      // 7's "a 401 forces an immediate, out-of-cycle poll", not a rate/5xx
      // condition. Safe to retry regardless of method: SpaceTraders rejects
      // bad auth before any mutation logic runs, so no side effect occurred.
      const isAuthFailure = !isUnauthenticatedRoot && upstream !== null && upstream.status === 401;
      const retryable =
        upstream === null
          ? sideEffectFree
          : upstream.status === 429 || isAuthFailure || (sideEffectFree && RETRYABLE_5XX.has(upstream.status));
      if (retryable && attempt < config.maxRetries) {
        // Release the pooled connection before abandoning this response.
        if (upstream !== null) await upstream.body?.cancel();
        if (isAuthFailure) {
          // Immediate: no backoff delay for a stale-credential retry, just a
          // fresh token before trying again.
          const refreshed = await authTokenClient.refreshAfterUnauthorized();
          if (refreshed !== null) headers.Authorization = `Bearer ${refreshed}`;
        } else {
          const delay = retryDelayMs(attempt, config, upstream?.headers.get("retry-after") ?? null);
          await sleep(delay);
        }
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
  const port = Number(process.env.PORT ?? 3002);
  const config: GatewayConfig = {
    ...configFromEnv(),
    authServiceSharedSecret: requireAuthServiceSharedSecret(),
    clerkJwtKeyPem: requireClerkJwtKey(),
  };
  createApp(config).listen(port, () => {
    console.log(`st-gateway listening on http://localhost:${port}`);
  });
}
