# st-gateway

Global SpaceTraders request gateway for the V-M-Pioneer-Trading services
([meta#5](https://github.com/V-M-Pioneer-Trading/meta/issues/5)).

Every outbound SpaceTraders call from navigation-service, agent-service, and
fleet-service is meant to flow through this proxy so the whole system shares
**one** rate budget instead of three independent clients tripping 429s
([meta#1](https://github.com/V-M-Pioneer-Trading/meta/issues/1)).

## What it does

- **Proxy**: `ANY /proxy/<spacetraders-path>` forwards the request (method,
  query string, body) to the SpaceTraders API and returns the upstream
  response unchanged.
- **Credential injection** (`meta/docs/design/auth-design.md` decision 5): the
  gateway fetches the SpaceTraders agent token from `auth-service`, caches it
  in memory, and injects it as `Authorization` on every upstream call itself —
  it no longer forwards whatever a caller sends. `GET /` is the one exception:
  SpaceTraders' unauthenticated root needs no credential, and not injecting
  there is what lets auth-service poll it *through* this gateway without a
  cycle. When auth-service has no token to give (`UNCONFIGURED`), the gateway
  returns `503` on every other game call rather than trying SpaceTraders
  anyway. On a `401` from SpaceTraders, it forces an out-of-cycle refresh from
  auth-service (`?afterUnauthorized=true`, decision 7) and retries once with
  the fresh token, immediately and without backoff.
- **Global rate budget**: a single token bucket (default ~2 req/s, burst 1)
  gates every upstream request, FIFO across all callers.
- **Centralized retry**: 429s and 401s are always retried (never executed
  upstream, or rejected before any mutation logic ran). 5xx and network
  failures are retried only for side-effect-free methods (GET/HEAD/OPTIONS): a
  POST that may already have executed a purchase upstream is never replayed.
  Non-retryable statuses (404, …) pass through unchanged, including
  `Retry-After`/`x-ratelimit-*` pacing headers.
- **Priority classes, derived from identity, not declared** (decision 2): the
  caller's own `Authorization` header (a Clerk session/M2M token, once the
  four calling services forward it — see the known gap below) is verified
  locally. A genuine human Clerk session (`sub` prefixed `user_`) earns the
  interactive lane; everything else — no token, an expired/invalid one, or a
  Clerk M2M token (`sub` prefixed `mch_`, decision 19) — is background.
  `X-Priority` is no longer read at all: a client can no longer self-declare
  interactive. Draining is strict (interactive always goes first, no fairness
  cap), so sustained interactive load can still starve background traffic —
  unchanged from before, just no longer spoofable.
  **Known interim gap**: none of the four calling services forward their own
  Clerk token to this gateway yet (increment 3 Stage 5 changes that) — until
  then, every request's `Authorization` fails verification here and
  everything, including genuinely interactive dashboard traffic, resolves to
  background. Accepted deliberately: shipping verification now closes the
  priority-spoofing gap immediately rather than leaving it open until Stage 5.
- **Observability**: `GET /metrics` returns per-class queue depth and wait
  latency (count/avg/max), so it's visible when the rate budget is the
  bottleneck.
- `GET /health` liveness endpoint.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3002` | Listen port |
| `SPACETRADERS_BASE_URL` | `https://api.spacetraders.io/v2` | Upstream base URL |
| `RATE_LIMIT_RPS` | `2` | Global budget, requests/second |
| `RATE_LIMIT_BURST` | `1` | Bucket capacity: requests dispatchable back-to-back (min 1) |
| `MAX_RETRIES` | `5` | Retries after the initial attempt |
| `RETRY_BASE_MS` | `500` | First backoff delay; doubles per retry |
| `MAX_RETRY_DELAY_MS` | `30000` | Ceiling on any single retry delay |
| `AUTH_SERVICE_URL` | `http://localhost:8082` | Where `GET /auth/v1/token` is fetched from |
| `AUTH_SERVICE_SHARED_SECRET` | *(required)* | Presented as `X-Auth-Service-Secret` on every token fetch |
| `AUTH_SERVICE_TOKEN_CACHE_MS` | `30000` | How long a fetched token is served from cache before a normal refetch |
| `CLERK_JWT_KEY` / `CLERK_JWT_KEY_FILE` | *(required)* | Clerk's RS256 public key — inline wins over file |
| `CLERK_ISSUER` | *(none)* | Optional `iss` claim check |

Invalid numeric values, and a missing `AUTH_SERVICE_SHARED_SECRET` or Clerk
key, fail startup with a clear error instead of hanging or running with
authentication silently off.

## Endpoints

- `GET /health` — `{ status: "ok" }`
- `GET /metrics` — `{ queues: { interactive, background }: { depth, latencyMs: { count, avg, max } } }`
- `ANY /proxy/<spacetraders-path>` — proxied SpaceTraders call

## Develop

```bash
npm install
npm test        # jest + supertest against an in-process fake SpaceTraders API
npm run dev     # build + start
```

Tests drive the proxy HTTP boundary only — in-process fake SpaceTraders and
auth-service servers are the seams, per the project's testing decisions.
