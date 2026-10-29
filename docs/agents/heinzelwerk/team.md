# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo.

- **Autonomy**: full. Agents merge and apply on their own; breakages are learnings. Secrets are never published (name the variable, never the value); the gate never merges its own policy.
- **Backend paths**: whole repo (`src/`, `Dockerfile`, `.github/`)
- **Worktree setup** (run once in every new task worktree): `npm ci`
- **Checks** (validator runs every one, in order; copied from CI, quiet flags only):
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm audit --audit-level=high (red on main: V-M-Pioneer-Trading/meta#136; not in CI)`
  - `docker buildx build --platform linux/arm64 . (unverified locally: docker daemon not running)`
- **Verified against**: c35e565 2026-10-29 (checks and every ref in this file; retro bumps it)
- **Coding standards**: `eslint.config.mjs:1` (shared `base` from `@v-m-pioneer-trading/eslint-config`, `package.json:26`), `eslint . --max-warnings 0` (`package.json:15`); disables carry `-- <reason>` (`src/server.ts:299`, `:330`); `CLAUDE.md` "## Invariants" (:64) and "### Dependency rules" (:44)
- **Risk areas** (validator reviews diffs touching these on Opus):
  - `ANY /proxy/<path>` in `src/server.ts:331`: unauthenticated, spends credits on the whole SpaceTraders account; no route checks auth (`src/server.ts:5-13`)
  - `src/server.ts:150-154` `credentialModeFor`: decides inject / forward / none from `req.path`, never `req.url` (`CLAUDE.md:71-74`); a wrong branch sends the agent token or the account token to the wrong place
  - `src/server.ts:219-223`, `:282-302`: retry rules; POST 5xx/network is never retried (at-most-once for purchases and sells); 429 and a changed-token 401 are
  - `src/authServiceClient.ts:44-69`, `src/config.ts:107-133`: vault fetch with `AUTH_SERVICE_SHARED_SECRET`; the agent token spends the whole account; the secret must differ from `AUTH_INTROSPECTION_SECRET`
  - `src/server.ts:239-240`, `src/config.ts:35-40`: lane derivation; never rejects a request, never decides authorization (`CLAUDE.md:94-99`)
  - `src/tokenBucket.ts:22-31`, `src/config.ts:76-77`: the single global rate budget; every upstream `fetch` must follow `bucket.acquire()`
  - `/metrics` shape and the `Priority` union in `src/tokenBucket.ts`: public wire format (`CLAUDE.md:159`)
  - `src/shutdown.ts:15-25`: `SHUTDOWN_TIMEOUT_MS` 8000 must stay below the deploy's `docker stop -t 9` (`../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:273`)
  - `.github/workflows/container.yml:73-223`: a merge to `main` deploys to production; deploy rides agent-service's SSM document `agent-service-bootstrap-i-011b6b82a9072a385` and restarts agent-service's MySQL (`:168-171`)
  - `.github/workflows/container.yml:48` job `test`: required check, never rename (verified 2026-10-29 @ c35e565: `gh api …/branches/main/protection/required_status_checks` → ["test"])
  - new required env var: the infrastructure change lands first, or the image crash-loops on the host (`.github/workflows/container.yml:179-184`; the bootstrap now polls `/health` and fails the command, `../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:315-330`, so the CI comment at `:177-178` is stale)
  - the `{ error: { message } }` envelope of every gateway-generated error (`src/server.ts:248,324-326,344,350-353`): callers branch on the sentences, the two 503s differ only by message (`../meta/fixtures/gateway-errors.json:51,60`); a reworded string breaks agent-service, fleet-service and navigation-service
  - `Dockerfile:5`: both tsconfigs must stay in the build stage `COPY` (TS5058)
  - `src/__tests__/fixtures/introspection.json`: sha256-pinned vendored copy (`src/__tests__/fixtures/SOURCE.txt:3-10`)
- **Contracts** (see team-modes **Contract changes**; validator checks every diff touching these):
  - Provided: `ANY /proxy/<st-path>` (`src/server.ts:331`), `GET /health`, `GET /api/st-gateway/health` (`src/server.ts:201-205`), `GET /metrics` (`src/server.ts:207-209`) · consumers agent-service (`../agent-service/src/config.ts:234`), fleet-service (`../fleet-service/src/spacetraders/client.ts:73`), navigation-service (`../navigation-service/src/main/resources/application.properties:18`), auth-service poller (`../auth-service/src/config.ts:276`); automation-service reaches it only through those; Caddy routes only `/api/st-gateway/health` publicly (`../V-M-Pioneer-Trading_infrastructure/caddy/Caddyfile.tftpl:63-68`)
  - Provided: the error sentences meta's fixture pins (`$comment` `../meta/fixtures/gateway-errors.json:2`): `SpaceTraders credential not configured` (`src/server.ts:47,248`; `../meta/fixtures/gateway-errors.json:51`), `auth-service unavailable: cannot obtain a SpaceTraders credential` (`src/server.ts:48,248`; `../meta/fixtures/gateway-errors.json:60`), `SpaceTraders unreachable` prefix (`src/server.ts:324-326`; `../meta/fixtures/gateway-errors.json:72-74`) · consumers agent-service, fleet-service, navigation-service (they vendor the fixture)
  - Consumed: auth-service `GET /auth/v1/token[?afterUnauthorized=true]` with `X-Auth-Service-Secret`, reply `{agentToken}` (`src/authServiceClient.ts:65-69`) · provider auth-service; auth-service `POST /auth/v1/introspect` via clerk-client v2.0.1 (`package.json:18`, `src/config.ts:107-110`) · provider auth-service; SpaceTraders at `SPACETRADERS_BASE_URL` (`src/config.ts:75`) · provider SpaceTraders (upstream)
  - Vendored: `src/__tests__/fixtures/introspection.json`, copy of meta `../meta/fixtures/introspection.json`, fixture v7, pinned in `src/__tests__/fixtures/SOURCE.txt:3-10` and `src/__tests__/lane.conformance.test.ts:30-31` · provider meta; re-vendor meta first, steps `src/__tests__/fixtures/SOURCE.txt:41-48`
  - Env var names (set by the SSM bootstrap in `../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:306`) · provider infrastructure
