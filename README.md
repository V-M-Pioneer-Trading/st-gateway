# st-gateway

Global SpaceTraders request gateway for the V-M-Pioneer-Trading services
([meta#5](https://github.com/V-M-Pioneer-Trading/meta/issues/5)).

Every outbound SpaceTraders call from navigation-service, agent-service, and
fleet-service is meant to flow through this proxy so the whole system shares
**one** rate budget instead of three independent clients tripping 429s
([meta#1](https://github.com/V-M-Pioneer-Trading/meta/issues/1)).

## What it does

- **Proxy**: `ANY /proxy/<spacetraders-path>` forwards the request verbatim
  (method, query string, body, `Authorization` header — never stored) to the
  SpaceTraders API and returns the upstream response unchanged.
- **Global rate budget**: a single token bucket (default ~2 req/s, burst 1)
  gates every upstream request, FIFO across all callers.
- **Centralized retry**: 429s are always retried with exponential backoff
  (honoring `Retry-After`, delta-seconds or HTTP-date, capped at
  `MAX_RETRY_DELAY_MS`) — a rate-limited request was never executed. 5xx and
  network failures are retried only for side-effect-free methods (GET/HEAD/
  OPTIONS): a POST that may already have executed a purchase upstream is
  never replayed. Non-retryable statuses (401, 404, …) pass through
  unchanged, including `Retry-After`/`x-ratelimit-*` pacing headers.
- **Priority classes**: callers set `X-Priority: interactive` on a `/proxy`
  request to jump the queue ahead of unmarked (background) traffic — the UI
  stays responsive while autopilot saturates the rate budget. Requests
  without the header are background; there is no default promotion. This is
  a trust boundary, not an auth boundary: any caller that can reach `/proxy`
  can self-declare interactive, and draining is strict (interactive always
  goes first, no fairness cap), so sustained interactive load can starve
  background traffic. Acceptable because only the three internal services
  call the gateway ([meta#7](https://github.com/V-M-Pioneer-Trading/meta/issues/7)),
  not untrusted clients — revisit if that changes.
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

Invalid numeric values fail startup with a clear error instead of hanging the
proxy at runtime.

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

Tests drive the proxy HTTP boundary only — the fake SpaceTraders server is the
single seam, per the project's testing decisions.
