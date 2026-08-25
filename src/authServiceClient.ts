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
 * Both return null (never throw) on any failure — network error, auth-service
 * unreachable, or a non-2xx response (503 UNCONFIGURED, 403 misconfigured
 * shared secret). Callers treat null as "no credential available right now".
 */

export interface AuthTokenClient {
  getToken(): Promise<string | null>;
  refreshAfterUnauthorized(): Promise<string | null>;
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

  async function fetchToken(afterUnauthorized: boolean): Promise<string | null> {
    const url = `${config.authServiceUrl}/auth/v1/token${afterUnauthorized ? "?afterUnauthorized=true" : ""}`;

    let res: Response;
    try {
      res = await fetch(url, { headers: { "X-Auth-Service-Secret": config.authServiceSharedSecret } });
    } catch {
      return null;
    }
    if (!res.ok) return null;

    let body: TokenResponse;
    try {
      body = (await res.json()) as TokenResponse;
    } catch {
      return null;
    }
    if (typeof body.agentToken !== "string" || body.agentToken.length === 0) return null;

    cached = { token: body.agentToken, fetchedAt: Date.now() };
    return body.agentToken;
  }

  return {
    async getToken() {
      if (cached !== null && Date.now() - cached.fetchedAt < config.cacheTtlMs) {
        return cached.token;
      }
      return fetchToken(false);
    },
    async refreshAfterUnauthorized() {
      return fetchToken(true);
    },
  };
}
