# Repo map: V-M-Pioneer-Trading/st-gateway
Verified against c35e565 2026-10-29.

## Purpose
- Global SpaceTraders gateway: one token-bucket budget, injected agent token, central retry, identity-derived queue lane; never authorizes callers. `package.json:4`, `src/server.ts:1-25`
- Single instance only (SpaceTraders limits per account). `CLAUDE.md:173-174`
- Node >=24. `package.json:7`

## Layout
- `src/server.ts`: only module importing express; lane, `/proxy` handler, retry loop, credential mode.
- Leaves, import nothing local: `src/config.ts`, `src/tokenBucket.ts`, `src/authServiceClient.ts`. `CLAUDE.md:34-40`, `:44-55`
- `src/shutdown.ts`: drain bound. Test fakes: `src/testSupport/`.
- `configFromEnv` and the `require*()` helpers are the only env readers. `src/config.ts:43-83`, `CLAUDE.md:102-104`
- Docs: `README.md`, `CLAUDE.md`, `src/__tests__/fixtures/SOURCE.txt`; refs `../meta/docs/operations.md` (`.github/workflows/container.yml:169`), `token-introspection.md` (`src/server.ts:10`), auth-design decisions 2/5/21 (`src/server.ts:16`); no docs outside `docs/agents/` (verified 2026-10-29 @ c35e565: `git ls-tree -r --name-only origin/main | grep '^docs/'` → no output).

## Entry points and lanes
- GET `/health`, GET `/api/st-gateway/health` return `{status:"ok"}`; GET `/metrics` returns `{queues:{interactive,background}}`; all unauthenticated. `src/server.ts:201-209`, `README.md:294-297`
- ANY method `/proxy/<st-path>`: raw body, 5mb (413 above), never parsed; `X-Priority` ignored. `src/server.ts:331`, `:213-215`, `:232`
- Credential mode from method + `req.path`: GET `/` none; POST `/register` forwards caller Authorization verbatim; else inject agent token (503 if auth-service cannot supply). `src/server.ts:150-154`, `:242-252`
- Lane: `interactive` only for an active `kind=operator`; everything else (machine, none, malformed, two Authorization lines, `/register`, center down) is `background`; derived once per request, 250 ms, never rejects. `src/server.ts:62`, `:113-116`, `:239-240`
- Bucket: `RATE_LIMIT_RPS` 2, `RATE_LIMIT_BURST` 1; two FIFO queues, interactive first. `src/config.ts:76-77`, `src/tokenBucket.ts:22-31`
- Retries (`MAX_RETRIES` 5): 429 always; 5xx/network only GET/HEAD/OPTIONS; 401 (inject only) if refresh yields a different token. `src/config.ts:78`, `src/server.ts:223`, `:282-302`

## Unauthenticated exposure
- No route checks auth; anyone reaching the port can spend via `/proxy`. `src/server.ts:5-13`, `:331`
- Container on bridge `authnet` 172.28.0.10, published only on host loopback `127.0.0.1:3002`. `../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:166`, `:306`
- Public path: security group opens 443 from CloudFront prefix list `../V-M-Pioneer-Trading_infrastructure/navigation-service/main.tf:198-209`; Caddy 403s without `X-Origin-Verify` and routes only `/api/st-gateway/health` here. `../V-M-Pioneer-Trading_infrastructure/caddy/Caddyfile.tftpl:30`, `:38`, `:63-68`, `:91-93`
- No iptables guard on st-gateway (guards match auth-service's IP only): `/proxy` is open to every host process and `--network host` container (agent, fleet, navigation, automation and their DBs) plus authnet members auth-service and Caddy. `../V-M-Pioneer-Trading_infrastructure/auth-service/main.tf:305-311`, `:346`, `:371`; `../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:280-285`, `:368`

## Money and spend
- No spend/read distinction: every injected non-GET may spend ("purchases, sells"). `src/server.ts:219-223`
- POST 5xx/network is never retried (at-most-once); 429 and 401 are. `src/server.ts:283-286`
- `AUTH_SERVICE_SHARED_SECRET` unlocks the agent token that spends the whole account; must differ from the introspection secret. `src/config.ts:112-126`; only st-gateway and auth-service receive it. `../V-M-Pioneer-Trading_infrastructure/auth-service/main.tf:365-366`
- No paid external API in `src/` (verified 2026-10-29 @ c35e565: `grep -rnE 'fetch\(' src --include=*.ts --exclude-dir=__tests__ --exclude-dir=testSupport` → `src/authServiceClient.ts:69` and `src/server.ts:266` only, the vault and the SpaceTraders proxy).

## Calls and called-by
- Out: SpaceTraders at `SPACETRADERS_BASE_URL` (default `https://api.spacetraders.io/v2`). `src/config.ts:75`
- Out: vault `GET {AUTH_SERVICE_URL}/auth/v1/token[?afterUnauthorized=true]`, header `X-Auth-Service-Secret`, reply `{agentToken}`. `src/authServiceClient.ts:44`, `:65-69`
- Out: introspection POST `AUTH_INTROSPECTION_URL` (full URL), `X-Introspection-Secret`, via clerk-client. `src/config.ts:35-40`, `:107-110`, `src/server.ts:189-199`
- Deps: clerk-client v2.0.1 `package.json:18`; eslint-config v1.1.0 `package.json:26`.
- In: agent-service `../agent-service/src/config.ts:234`; auth-service polls GET `/` and POST `/register` `../auth-service/src/config.ts:276`; fleet-service `../fleet-service/src/spacetraders/client.ts:73`; navigation-service `../navigation-service/src/main/resources/application.properties:18`.
- automation-service never calls it directly; its machine token arrives via agent, fleet, navigation. `../automation-service/src/gameClients.ts:1-11`
- command-interface hits only `/api/st-gateway/health`. `../command-interface/src/api/healthService.ts:46-51`
- Vendored fixture from meta f226e5f4, v7, 77984 B, sha256 in `src/__tests__/fixtures/SOURCE.txt:3-10`, pinned `src/__tests__/lane.conformance.test.ts:30-31`; drives 19 gateway cases, skips 56 `src/__tests__/fixtures/SOURCE.txt:27-33`; re-vendor meta first `src/__tests__/fixtures/SOURCE.txt:41-48`.

## Persistence
- None: in-memory queues, 30 s agent-token cache, in-flight dedupe. `src/authServiceClient.ts:48-55`, `src/config.ts:82`

## Build, test, run
- Scripts: build (`tsconfig.build.json` to `dist/`), start, dev, typecheck, test (jest), lint. `package.json:10-15`
- One test: `npx jest src/__tests__/tokenBucket.test.ts`. `CLAUDE.md:12`
- Jest ts-jest, roots `src`. `jest.config.js:2-5`
- Required env, crash before bind: `AUTH_SERVICE_SHARED_SECRET`, `AUTH_INTROSPECTION_URL`, `AUTH_INTROSPECTION_SECRET`; PORT 3002. `src/config.ts:107-110`, `:127-133`, `:74`
- Env table `README.md:221-234`; prod env `../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:306`.
- Ignored: `node_modules/`, `dist/`. `./.gitignore:1-2`

## CI and deploy
- `.github/workflows/container.yml`: triggers pull_request, push main, tags `v*`, dispatch `:7-16`; main shares group `deploy-<repo>`, no cancel `:39-41`.
- `test` (ubuntu-latest, 15 min): checkout, setup-node 24 + npm cache, `npm ci`, typecheck, lint, test. `.github/workflows/container.yml:48-71`
- `docker` (non-PR, needs `test`, arm64 runner, `packages` + `id-token` write): `:73-95`; tip-of-main check `:105-127`; GHCR login `:131-136`; tags `sha-<long>` + `latest` if deploy `:138-144`; build-push arm64 `:146-159`; AWS role `github-actions-ssm-deploy` `:161-166`; SSM `agent-service-bootstrap-i-011b6b82a9072a385`, polls 90x10 s `:188-223`.
- Tags build, never deploy. `.github/workflows/container.yml:103-104`

## Patterns
- `{error:{message}}` envelope. `src/server.ts:248`, `:324-326`, `:350-353`
- Test fakes and `useHarness()`; `gw.app({maxRetries:0})`. `CLAUDE.md:40`, `:196-205`
- Recipes for extending. `CLAUDE.md:253-273`
- Regression test comment states the old behaviour. `CLAUDE.md:246-248`
- Lint: shared `base`; eslint ^10.12.0 `package.json:27`, typescript-eslint ^8.71.0 `package.json:32`; `meta#105` `.github/workflows/container.yml:67`.

## Traps
- Dockerfile COPY must list both tsconfigs (TS5058). `Dockerfile:5`, `CLAUDE.md:23-30`
- Mode and lane use `req.path`, not `req.url`; lane input is `soleAuthorizationLine(req)`. `src/server.ts:212`, `:217`, `:240`, `CLAUDE.md:71-74`
- Body consumed once. `src/server.ts:300`, `:305`, `:312`
- `SHUTDOWN_TIMEOUT_MS` 8000 below deploy's `docker stop -t 9`. `src/shutdown.ts:15-25`, `../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:273`
- Hanging-center test ceiling 450 ms, never past 500. `CLAUDE.md:230-236`
- `CLERK_*` env ignored. `src/config.ts:100-105`
- Aborted callers' tokens are not reclaimed. `README.md:292-293`
- Deploy rides agent-service's SSM document and restarts its MySQL. `.github/workflows/container.yml:168-171`
- CI comment says st-gateway is unchecked (`:177-178`), but the bootstrap now polls `/health` 30x3 s and fails the command. `../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:315-330`
- New required env must land in infrastructure first. `.github/workflows/container.yml:179-184`

## Reference docs
- `./README.md` "Lanes": read when changing lane derivation or center answers.
- `./README.md` "Errors the gateway generates itself": read when debugging a 502/503/413 from the gateway.
- `src/__tests__/fixtures/SOURCE.txt`: read when meta/fixtures/introspection.json changes (re-vendor) or when bumping clerk-client or the fixture version (history).
