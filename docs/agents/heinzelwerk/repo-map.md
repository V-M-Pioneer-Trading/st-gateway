# Repo map: st-gateway

Facts verified against origin/main c35e565 on 2026-10-27, each with `path:line`. Line numbers drift: open the file before relying on one.

1. PURPOSE: Express proxy; every SpaceTraders call shares one token bucket, gateway injects the agent token, central retry (src/server.ts:1-3; README.md:3-7).
2. ENTRY POINTS (no inbound credential check; never answers 401/403 itself: src/server.ts:5-10)
- GET /health, GET /api/st-gateway/health -> {status:"ok"} (src/server.ts:201-205). GET /metrics -> {queues: bucket.getMetrics()} (src/server.ts:207-209).
- ANY /proxy/* (express.raw */*, 5mb; try/catch -> 502): src/server.ts:331-346. Upstream URL = SPACETRADERS_BASE_URL + req.url (src/server.ts:212). Only Content-Type + Authorization sent upstream (src/server.ts:214-215,242-252).
- Credential mode by method + req.path (src/server.ts:150-154,217): GET / -> none; POST /register -> forward caller's Authorization verbatim (account token; none sent if absent, src/server.ts:242-244); all else (HEAD / included) -> inject Bearer agent token.
- Caller's Authorization only picks a lane: interactive iff introspection says active kind=operator, else background; POST /register always background, never introspected (src/server.ts:15-21,113-116,239-240). X-Priority not read (src/server.ts:232).
3. UNAUTHENTICATED: /health, /api/st-gateway/health, /metrics (src/server.ts:204-209; README.md:193-195). /proxy/* too: any caller reaching the port gets the agent token injected and spends the budget (src/server.ts:217,245-251,258). Introspection/vault secrets are outbound only (src/server.ts:184-198).
4. SPEND PATHS
- Budget: TokenBucket(RATE_LIMIT_RPS def 2, RATE_LIMIT_BURST def 1), two FIFO queues, interactive drained first (src/config.ts:76-77; src/tokenBucket.ts:22-31,76). The only upstream fetch is src/server.ts:266.
- Each attempt: client-gone check, bucket.acquire(priority), client-gone check, fetch (src/server.ts:255-270; CLAUDE.md:65-67,126-130). Token of a caller that left after acquire is not reclaimed (src/server.ts:259-262).
- Inject with no token -> 503 before any acquire (src/server.ts:245-250; CLAUDE.md:123-125).
- Retries (MAX_RETRIES def 5, src/config.ts:78): 429 always; 5xx (500/502/503/504) and network errors only for GET/HEAD/OPTIONS, so POSTs at-most-once (src/server.ts:41,219-223,283-287). 401 in inject mode retried for any method, immediately, only if refreshAfterUnauthorized returns a different token (src/server.ts:282-302). Backoff = min(max(base*2^attempt, Retry-After), MAX_RETRY_DELAY_MS) (src/server.ts:156-167; defs 500/30000 ms src/config.ts:79-80).
- Lane derived once per request, 250 ms timeout (src/server.ts:62,191-195,239-240). Exhausted/network -> 502 (src/server.ts:324-326).
5. CALLS / CALLED BY
- SpaceTraders: SPACETRADERS_BASE_URL, def https://api.spacetraders.io/v2 (src/config.ts:75).
- auth-service vault: GET ${AUTH_SERVICE_URL}/auth/v1/token[?afterUnauthorized=true], header X-Auth-Service-Secret = AUTH_SERVICE_SHARED_SECRET (src/authServiceClient.ts:64-69). Def URL http://localhost:8082, cache AUTH_SERVICE_TOKEN_CACHE_MS def 30000 (src/config.ts:81-82). Cold fetch deduped (src/authServiceClient.ts:55,103-111).
- auth-service introspection: AUTH_INTROSPECTION_URL (full endpoint) + AUTH_INTROSPECTION_SECRET, both required, via clerk-client createIntrospector, sent as X-Introspection-Secret (src/server.ts:189-199; src/config.ts:35-40,107-110; README.md:233-234).
- PORT def 3002 (src/config.ts:74). Missing AUTH_SERVICE_SHARED_SECRET / AUTH_INTROSPECTION_* throws before listen (src/server.ts:365-372; src/config.ts:127-133,140-144).
- Called by: navigation/agent/fleet-service, automation-service, auth-service polling GET / through gateway (src/server.ts:15-21; README.md:48-51). Caller env var names not in this repo.
6. BUILD/TEST/RUN: npm ci; build `tsc -p tsconfig.build.json`; start `node dist/server.js`; dev `npm run build && npm start`; typecheck `tsc --noEmit`; lint `eslint . --max-warnings 0`; test `jest` (package.json:9-16). ~15 s, no external services; single file `npx jest src/__tests__/tokenBucket.test.ts` (CLAUDE.md:11-12). Node >=24 (package.json:6-8). Dockerfile node:24-alpine, EXPOSE 3002 (Dockerfile:1,15).
7. CI: only .github/workflows/container.yml. Triggers pull_request (no filter), push main + tags v*, workflow_dispatch (:7-16); permissions contents read (:18-19); concurrency deploy-<repo> for non-PR main runs else run-<run_id>, cancel-in-progress false (:39-41).
- Job test (ubuntu-latest, timeout 15, :48-71), steps in order: actions/checkout@v4; actions/setup-node@v4 (node-version 24, cache npm); npm ci; npm run typecheck; npm run lint; npm test.
- Job docker (:73-223): if event != pull_request (:75); needs test; permissions contents read, packages write, id-token write; ubuntu-24.04-arm; timeout 30. Steps: checkout@v4; "Check this commit is still the tip of main" (id tip; git ls-remote --exit-code; deploy=true only if GITHUB_REF is main and tip == GITHUB_SHA, :105-127); docker/setup-buildx-action@v3; "Log in to GHCR" docker/login-action@v3 (ghcr.io, actor, GITHUB_TOKEN); docker/metadata-action@v5 (id meta; ghcr.io/v-m-pioneer-trading/st-gateway; type=sha,format=long + latest if deploy); "Build and push image" docker/build-push-action@v6 (context ., linux/arm64, push true, gha cache, ignore-error on export); if deploy: aws-actions/configure-aws-credentials@v4 (arn:aws:iam::543292785457:role/github-actions-ssm-deploy, eu-central-1); if deploy: "Redeploy on shared host" aws ssm send-command (doc agent-service-bootstrap-i-011b6b82a9072a385, instance i-011b6b82a9072a385, --timeout-seconds 600), polls 90x10 s (:161-223).
8. PERSISTENCE: none. In memory only: token cache + in-flight fetch (src/authServiceClient.ts:48,55), bucket queues/stats (src/tokenBucket.ts:31-32).
9. PATTERNS: config/tokenBucket/authServiceClient are leaves; authServiceClient takes its own narrow config; only server.ts imports express; clerk-client only in server.ts + config.ts (CLAUDE.md:44-55). Lane only via createLaneDeriver, never parse tokens or read sub; lane never rejects (CLAUDE.md:49-51,90-95). Lane from soleAuthorizationLine(req), not req.header (src/server.ts:240; CLAUDE.md:101-104). configFromEnv is the only process.env reader besides require*() (CLAUDE.md:98-100). Tests use fakes + useHarness in src/testSupport/ (CLAUDE.md:40,196-205).
10. TRAPS
- Credential mode must use req.path, not req.url (POST /register?x=1) (CLAUDE.md:68-71; src/server.ts:145-146,217).
- Both tsconfigs must be COPYed in Dockerfile build stage, else TS5058 only in image builds (CLAUDE.md:23-30; Dockerfile:5).
- Each fetch body consumed exactly once: cancel() on retry, text() on relay (CLAUDE.md:72-80; src/server.ts:300,305,312). The try/catch around proxy() is load-bearing, Express 4 drops async rejections (src/server.ts:329-346; CLAUDE.md:81-84).
- Failed forced refresh must clear the cache (src/authServiceClient.ts:113-121; CLAUDE.md:85-87). 401 retry skipped if refresh returns same token (src/server.ts:296).
- Center down = operators silently background; one warning per minute (src/server.ts:64-71,80-105).
- Deps are release tarballs: clerk-client v2.0.1, eslint-config v1.1.0 (package.json:18,26).
- CI deploys only main's tip; stale runs skip with warning; recover via workflow_dispatch on main (container.yml:33-38,105-127). PRs run only job test (container.yml:75).
- Missing AUTH_INTROSPECTION_* = crash loop, every game call 502s at its caller; bootstrap does not health-check st-gateway (CLAUDE.md:139-141; container.yml:177-184).
11. EXISTING DOCS: README.md (306 lines: architecture/request mermaid, credential + retry policy, lanes, endpoints, errors, config, limitations; README.md:31,87,97,143,189,202,219,273). CLAUDE.md (274 lines: commands, module map, dependency rules, 12 invariants, critical sequences, testing; CLAUDE.md:6,32,42,61,114,185). src/__tests__/fixtures/SOURCE.txt: provenance of introspection.json (CLAUDE.md:207-210).

## Reference docs

- `README.md` Retry policy and Lanes tables: read when changing retries or lanes.
