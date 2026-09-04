# CLAUDE.md — st-gateway

Contributor and agent notes. Behaviour, rationale and configuration live in
`README.md`; this file is about working on the code without breaking it.

## Commands

| Command | Notes |
|---|---|
| `npm ci` | what CI and both Docker stages use |
| `npm test` | full jest suite; ~15 s, no external services needed |
| `npx jest src/__tests__/tokenBucket.test.ts` | the fast level — pure unit, no sockets |
| `npm run typecheck` | `tsc --noEmit` over **all** of `src/`, tests included |
| `npm run build` | `tsc -p tsconfig.build.json` → `dist/`, production sources only |
| `npm start` | `node dist/server.js` |

`tsconfig.json` includes the tests (so typecheck covers them);
`tsconfig.build.json` excludes `src/__tests__` and `src/testSupport` so they
never reach `dist/` or the image. Editing one without the other either drops
type coverage or ships test code to production.

## Module map

| File | Owns | Imports from this repo |
|---|---|---|
| `src/server.ts` | Express wiring, the `/proxy` handler, the retry loop, credential mode, response relay, the startup block | `config`, `tokenBucket`, `authServiceClient`, `auth` |
| `src/config.ts` | `GatewayConfig`, env parsing, all startup validation | *(none)* |
| `src/tokenBucket.ts` | the global budget, the two priority queues, queue metrics, and the `Priority` union | *(none)* |
| `src/auth.ts` | Clerk RS256 verification → a `Priority` | `tokenBucket` (**type only**) |
| `src/authServiceClient.ts` | agent-token fetch, cache, in-flight dedupe, `TokenResult` | *(none)* |
| `src/testSupport/*` | the two fakes, ephemeral Clerk keypair, `useHarness()` | `server`, `config` |

### Dependency rules

- `config.ts`, `tokenBucket.ts` and `authServiceClient.ts` are **leaves**. They
  import nothing from this repo. Keep them that way — each is independently
  testable precisely because of it.
- `authServiceClient.ts` takes its own narrow config object rather than
  `GatewayConfig`. Do not make it import `config.ts`.
- `auth.ts` may import **only the `Priority` type** from `tokenBucket.ts`.
- `server.ts` is the only module that knows Express exists. Nothing else may
  import `express` or touch `req`/`res`.
- Nothing under `src/` outside `src/testSupport/` may import from
  `src/testSupport/` or `src/__tests__/`.
- The graph is a tree rooted at `server.ts`. There are no cycles; there is no
  reason to introduce one.

## Invariants

Each of these is stated so you can recognise a violation in a diff.

1. **Every upstream call is preceded by `bucket.acquire()` in the same loop
   iteration — retries included.** A `fetch(` in `server.ts` that is not
   downstream of an `acquire()` is a hole in the global budget.
2. **Credential mode is decided from `req.path`, never `req.url`.** `req.url`
   carries the query string and is used *only* to build the upstream URL. A
   comparison against `req.url` anywhere else is the bug that made
   `POST /register?x=1` inject the wrong token.
3. **An upstream response body is consumed exactly once**: `body.cancel()` on a
   path that retries, `.text()` on a path that relays — never both, never
   neither. Cancelling before a relay silently empties the caller's response.
4. **Nothing in the `/proxy` handler may throw past `proxy()`.** The `try` in
   `createApp`'s `app.use("/proxy", …)` is load-bearing: Express 4 ignores
   rejections from async handlers, so an unguarded throw leaves the caller's
   socket open forever. Any new `await` belongs inside `proxy()`.
5. **A forced refresh that fails clears the cache.** Keeping a credential
   SpaceTraders has just rejected turns one 401 into an outage lasting
   `AUTH_SERVICE_TOKEN_CACHE_MS`.
6. **A 401 is retried only when the refresh yields a *different* credential.**
   Otherwise the retry is a guaranteed second 401 charged to the shared budget.
7. **`derive()` never rejects a request.** It picks a queue and nothing else. No
   token, an expired one, a foreign-signed one and a machine token all resolve
   to `background`. Making it throw would turn priority into authorization,
   which belongs in the calling service.
8. **`createApp` assumes an already-validated `GatewayConfig`.** All range and
   type checking lives in `config.ts`, before the port is bound.
9. **`configFromEnv` is the only reader of `process.env`** outside the two
   `require*()` secret helpers. No inline `process.env` in `server.ts`.

## Critical sequences

**Per proxied request**, in this exact order:

1. `express.raw` buffers the body (never parsed — payloads are forwarded byte
   for byte).
2. Derive priority from the caller's `Authorization`. Must precede step 4:
   `acquire()` needs the class.
3. Resolve credential mode; on `inject` with no credential, answer 503 **and
   return**. This happens *before* any `acquire()`, so an unconfigured gateway
   never drains the budget.
4. Per attempt: connected? → `acquire()` → connected again? → `fetch` →
   classify → refresh-and-retry, back-off-and-retry, or relay.

The connectivity check runs on **both** sides of `acquire()`. The second one is
the one that matters: the queue wait is where callers give up.

**On a 401 while injecting**: refresh *first*, compare the credential, and only
then cancel the body and `continue`. Cancelling earlier throws away the upstream
error body that a no-op refresh still has to relay.

**At startup**: `configFromEnv()` → `requireAuthServiceSharedSecret()` →
`requireClerkJwtKey()` → `createApp()` → `listen()`. Every failure mode is a
crash before the port is bound, never a running-but-wrong process.

## Effectively public — do not change casually

| Surface | Who depends on it |
|---|---|
| `GET /api/st-gateway/health` | the shared host's health check routes `/api/st-gateway/*` here. `GET /health` is the local/direct alias. Removing either breaks a deployed probe. |
| `/proxy/<path>` prefix | every calling service's SpaceTraders client base URL |
| `/metrics` JSON shape | `queues.{interactive,background}.{depth,latencyMs:{count,avg,max}}` |
| the `Priority` union in `tokenBucket.ts` | it *is* the metrics wire format. The queue names, the stats keys and the JSON keys all derive from that one union — adding a class changes the response shape. |
| `{ error: { message } }` envelope | every gateway-generated error uses it, matching SpaceTraders' own shape so callers need one parser |
| auth-service contract | `GET /auth/v1/token`, header `X-Auth-Service-Secret`, query `?afterUnauthorized=true`, response `{ agentToken }` |
| env var names | set by the SSM bootstrap document on the shared host |

## Domain facts the code assumes

- SpaceTraders rate-limits **per account**, not per client. That is the whole
  reason the budget must be global and this service single-instance.
- `GET /` is the only unauthenticated SpaceTraders endpoint.
- `POST /register` authenticates with the **account** token — a different
  credential from the agent token, held only by auth-service. The gateway never
  sees it except as a header it forwards.
- SpaceTraders rejects bad auth *before* executing any mutation. That is what
  makes a 401 safe to retry on a POST, unlike a 5xx.
- `Retry-After` may be either a number of seconds or an HTTP date; both forms
  are parsed.
- Clerk: a human session's `sub` is `user_…`; an M2M token's `sub` is a Machine
  ID, `mch_…`. Only the former is interactive.
- Verification is networkless — an RS256 public key in PEM/SPKI form, imported
  once and reused. No JWKS fetch, no calls to Clerk at request time.

## Testing

Two levels, and the split is deliberate:

- **`src/__tests__/tokenBucket.test.ts`** — pure unit. Queue depth, drain order
  and stats are synchronous properties of the class, so they are asserted with
  no clock and no sockets.
- **Everything else** — the HTTP boundary via supertest, with in-process fake
  SpaceTraders and auth-service servers as the only seams.

`useHarness()` (`src/testSupport/gatewayHarness.ts`) builds fresh fakes and a
fresh app factory per test; both fakes expose a `respondWith(...)` queue whose
last entry repeats, and a `respondAfter(ms)` delay. Pass config differences as
overrides — `gw.app({ maxRetries: 0 })` — so a test states the setting it
actually depends on.

### Known flake patterns

- **Never assert queue depth from an HTTP test after a fixed sleep.** This was a
  real flake (`priority.test.ts`, failing 0/8 in isolation): a fixed 20 ms sleep
  raced the work that happens *before* a request is enqueued — the auth-service
  token fetch and the one-off `importSPKI`. On a cold process that work outlasts
  the sleep and depth reads 0. Depth assertions belong in the unit level.
- **Ordering assertions need `rateLimitBurst: 1` and a low `rateLimitRps`** so
  the queue is genuinely wide, and must assert on *relative arrival order*,
  never timestamps.
- **Elapsed-time lower bounds** (the rate-budget test, the `Retry-After` test)
  are the only remaining wall-clock assertions. Keep the margin generous — they
  assert a floor, never a ceiling.
- **A test that aborts a request must attach `.on("error", () => {})`** to it,
  or Node surfaces the deliberate abort as `socket hang up` and fails the test.
- `console.warn` / `console.error` output during the auth-failure and
  truncated-body tests is expected: those paths are supposed to be loud.

### Conventions

- One regression test per bug fixed, and **its comment states what the old
  behaviour was** — a reader must be able to tell what the test is defending
  without the git history.
- A regression test has to fail against the pre-fix code. If it can't be reached
  from the HTTP boundary, that's a signal to test the owning module directly,
  not to skip the test.

## Extending each moving part

- **A config value** → field on `GatewayConfig`, parsed in `configFromEnv` via
  `envNumber`/`envInteger` (never a bare `process.env` read), a row in the
  README table, and a default in the harness literal.
- **A priority class** → extend the `Priority` union in `tokenBucket.ts`. The
  queues, stats and metrics are all keyed by it, so the compiler will walk you
  through every site. Note that it changes the `/metrics` wire format.
- **A credential exception** → a branch in `credentialModeFor`, matched on
  method and path, plus a row in the README's credential-policy table.
- **A relayed response header** → `FORWARDED_HEADERS` in `server.ts`.
- **A retryable status** → `RETRYABLE_5XX` or the `retryable` expression beside
  it. Say explicitly whether it is method-sensitive: side-effect-free-only, or
  safe for mutations too, and why.
- **A gateway-generated error** → keep the `{ error: { message } }` envelope and
  add a row to the README's error table.

---

**This file is updated in the same PR as the change it describes.** A module
map, an invariant list or a flake note that lags the code is worse than none,
because it is trusted.
