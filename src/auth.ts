/**
 * @file Clerk session verification — permissive, not gating.
 *
 * st-gateway does not authorize requests (auth-design.md decision 18: that
 * happens once, in the calling service). Its only use for a Clerk token is
 * auth-design.md decision 2: derive request priority from a *verified*
 * identity instead of trusting a client-supplied X-Priority header, which any
 * caller — including an anonymous one, once decision 3 allows those through —
 * could otherwise set to "interactive" for free.
 *
 * So `derive` never rejects a request. No token, an expired/malformed token,
 * or a token signed by the wrong key all resolve the same way: background.
 * The only path to "interactive" is a verified session whose `sub` is a real
 * Clerk user (`user_...`) — a Clerk M2M token's `sub` is its Machine ID
 * (`mch_...`, decision 19), so a machine caller degrades to background too,
 * matching today's convention that only human/browser traffic is interactive.
 *
 * Same networkless RS256-via-PEM shape as every other service's auth.ts —
 * see fleet-service/src/auth.ts for the canonical version this was ported
 * from.
 *
 * Since increment 3 Stage 5 the calling services forward the caller's own
 * Clerk session verbatim: agent/fleet/navigation-service relay the dashboard's
 * human session (sub `user_…` → interactive), automation-service sends its
 * M2M machine token (sub `mch_…` → background), and auth-service's poll sends
 * nothing (→ background). Nothing else arrives on Authorization for game calls.
 */

import { importSPKI, jwtVerify, type KeyLike } from "jose";
import type { Priority } from "./tokenBucket";

const ALGORITHM = "RS256";

export interface AuthConfig {
  clerkJwtKeyPem: string;
  clerkIssuer: string | null;
}

export interface PriorityDeriver {
  derive(authorizationHeader: string | undefined): Promise<Priority>;
}

const bearerFrom = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join("");
  return token.length > 0 ? token : null;
};

export function createPriorityDeriver(config: AuthConfig): PriorityDeriver {
  if (config.clerkJwtKeyPem.length === 0) {
    throw new Error("clerkJwtKeyPem is required — refusing to start without a trust anchor");
  }

  let keyPromise: Promise<KeyLike> | null = null;
  const key = () => {
    keyPromise ??= importSPKI(config.clerkJwtKeyPem, ALGORITHM);
    return keyPromise;
  };

  return {
    async derive(authorizationHeader) {
      const token = bearerFrom(authorizationHeader);
      if (token === null) return "background";

      try {
        const { payload } = await jwtVerify(token, await key(), {
          algorithms: [ALGORITHM],
          ...(config.clerkIssuer !== null ? { issuer: config.clerkIssuer } : {}),
        });
        const sub = typeof payload.sub === "string" ? payload.sub : "";
        return sub.startsWith("user_") ? "interactive" : "background";
      } catch {
        return "background";
      }
    },
  };
}
