# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo.

- **Autonomy**: full. Agents merge and apply on their own; breakages are learnings. Secrets are never published (name the variable, never the value), and the gate never merges its own policy.
- **Backend paths**: whole repo (`src/`)
- **Worktree setup**: `npm ci`
- **Checks** (copied from `.github/workflows/container.yml`, jobs `test`, `docker`, in order):
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `docker build .` (unverified locally: docker daemon not running; the `docker` job builds linux/arm64)
- **Checks verified on main**: c35e565 2026-10-28
- **Coding standards**: `@v-m-pioneer-trading/eslint-config` base (`package.json:26`); module rules in `CLAUDE.md`
- **Risk areas** (validator reviews diffs touching these on Opus):
  - `src/server.ts` /proxy: checks no caller and injects the game token; every purchase, sell, refuel and contract call in the workspace passes here. The only guard is the network (127.0.0.1 + authnet in production)
  - Retry rules in `src/server.ts`: 5xx/network retried only for GET/HEAD/OPTIONS; 429 for every method; 401 only in inject mode with a different token
  - `src/tokenBucket.ts`: the one shared SpaceTraders rate budget
  - `src/authServiceClient.ts`: fetches the game token from auth-service
  - `.github/workflows/container.yml`: a merge to main deploys through agent-service's SSM document, which also restarts agent-service and its MySQL; a new required env var lands in infrastructure before the image
- **Contracts** (see team-modes **Contract changes**):
  - Provided: `/proxy/*` to agent-service, auth-service, fleet-service, navigation-service (each `ST_GATEWAY_URL` + /proxy)
  - Consumed: auth-service `GET /auth/v1/token` with `X-Auth-Service-Secret` (`src/authServiceClient.ts`) · provider auth-service; clerk-client `createLaneDeriver` · provider clerk-client
  - Vendored: `src/__tests__/fixtures/introspection.json`, copy of `../meta/fixtures/introspection.json`, pinned in `src/__tests__/fixtures/SOURCE.txt` · provider meta
    - Re-vendor: change meta first, then `git -C ../meta show HEAD:fixtures/introspection.json > src/__tests__/fixtures/introspection.json`, recompute bytes and sha256 of the copy, update the record in `SOURCE.txt` and the constants `FIXTURE_SHA256`/`FIXTURE_BYTES` in `src/__tests__/lane.conformance.test.ts:30-31` (`src/__tests__/fixtures/SOURCE.txt:41-47`).
  - Shared packages: clerk-client 2.0.1 (`package.json:18`), eslint-config 1.1.0 (`package.json:26`)
  - Infra outputs: st-gateway container in the agent-service stack · provider infrastructure (`../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf`)
