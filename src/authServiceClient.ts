/**
 * @file Client for auth-service's GET /auth/v1/token — auth-design.md
 * decision 5: st-gateway asks auth-service for the agent token, caches it in
 * memory, and injects it on every upstream call instead of forwarding
 * whatever a caller sends.
 *
 * Two entry points, matching decision 7's polling story from the other side:
 *  - getToken(): the normal path, served from cache within cacheTtlMs.
 *  - refreshAfterUnauthorized(): decision 7's "a 401 forces an immediate,
 *    out-of-cycle poll" — always bypasses the cache and tells auth-service
 *    (via ?afterUnauthorized=true) that this refresh followed a real 401, so
 *    it can conclude APP_TOKEN_EXPIRED if resetDate hasn't moved.
 *
 * Neither throws. Failure comes back as a TokenResult carrying *why*, because
 * "auth-service has no token for us" and "auth-service is not answering" need
 * different people to look at different systems.
 */

export type TokenFailure =
  /** auth-service answered and told us it has no agent token yet: its 503 UNCONFIGURED, or an empty body. */
  | "unconfigured"
  /**
   * auth-service could not be reached, spoke nonsense, or failed on its own
   * side (any other non-2xx — a 500, or a 403 meaning our shared secret is
   * wrong). Nothing is known about the credential; the fault is not the
   * SpaceTraders credential's.
   */
  | "unavailable";

export type TokenResult = { token: string } | { token: null; reason: TokenFailure };

export interface AuthTokenClient {
  getToken(): Promise<TokenResult>;
  refreshAfterUnauthorized(): Promise<TokenResult>;
}

export interface AuthTokenClientConfig {
  authServiceUrl: string;
  authServiceSharedSecret: string;
  cacheTtlMs: number;
}

interface TokenResponse {
  agentToken?: string;
}

export function createAuthTokenClient(config: AuthTokenClientConfig): AuthTokenClient {
  let cached: { token: string; fetchedAt: number } | null = null;
  /**
   * The cold-cache fetch in flight, if any. Without it, every request that
   * arrives while the first fetch is outstanding starts its own — so a cache
   * expiry under load became a burst of identical calls to auth-service
   * proportional to in-flight traffic.
   */
  let inFlight: Promise<TokenResult> | null = null;

  const fail = (reason: TokenFailure, detail: string): TokenResult => {
    // The only place these failures are visible: without a line here, a dead
    // auth-service looks identical to a healthy one holding no credential.
    console.warn(`st-gateway: auth-service token fetch failed (${reason}): ${detail}`);
    return { token: null, reason };
  };

  async function fetchToken(afterUnauthorized: boolean): Promise<TokenResult> {
    const url = `${config.authServiceUrl}/auth/v1/token${afterUnauthorized ? "?afterUnauthorized=true" : ""}`;

    let res: Response;
    try {
      res = await fetch(url, { headers: { "X-Auth-Service-Secret": config.authServiceSharedSecret } });
    } catch (err) {
      return fail("unavailable", String(err));
    }
    if (!res.ok) {
      // Nothing here reads the body, and an unread body keeps undici from
      // returning the socket to the pool — which matters precisely here,
      // because the failing case is a poll that repeats on every request.
      await res.body?.cancel();
      // 503 is auth-service's documented "I have no agent token yet"
      // (UNCONFIGURED). Any other status is auth-service failing on its own
      // side — a 500, or a 403 saying our shared secret is wrong — and
      // reporting those as an unconfigured SpaceTraders credential sends
      // whoever is paged to the one system that is fine.
      return res.status === 503
        ? fail("unconfigured", "HTTP 503 (auth-service reports no agent token)")
        : fail("unavailable", `HTTP ${res.status}`);
    }

    let body: TokenResponse;
    try {
      body = (await res.json()) as TokenResponse;
    } catch (err) {
      return fail("unavailable", `unparseable body: ${String(err)}`);
    }
    if (typeof body.agentToken !== "string" || body.agentToken.length === 0) {
      return fail("unconfigured", "response carried no agentToken");
    }

    cached = { token: body.agentToken, fetchedAt: Date.now() };
    return { token: body.agentToken };
  }

  return {
    async getToken() {
      if (cached !== null && Date.now() - cached.fetchedAt < config.cacheTtlMs) {
        return { token: cached.token };
      }
      inFlight ??= fetchToken(false).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    async refreshAfterUnauthorized() {
      const result = await fetchToken(true);
      if (result.token === null) {
        // SpaceTraders has just rejected whatever is in the cache. Keeping it
        // would re-inject a credential known to be dead on every subsequent
        // request until the TTL ran out — an outage we inflict on ourselves.
        cached = null;
      }
      return result;
    },
  };
}
