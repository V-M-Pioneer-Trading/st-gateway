# Repo map: st-gateway

The single door to SpaceTraders: one global rate budget (token bucket, `RATE_LIMIT_RPS` 2, burst 1), injects the agent token fetched from auth-service, picks the `interactive` or `background` lane from the center's answer, retries centrally. Single instance by design.

| Path | Holds |
|---|---|
| `src/server.ts` | `createApp`, `/proxy` handler, startup under `require.main` |
| `src/tokenBucket.ts` | rate budget; imports nothing from the repo |
| `src/authServiceClient.ts` | agent-token fetch (cache `AUTH_SERVICE_TOKEN_CACHE_MS` 30 s); imports nothing from the repo |
| `src/config.ts` | the only `process.env` reader |
| `src/shutdown.ts` | SIGTERM / SIGINT |
| `src/__tests__/fixtures/introspection.json` + `SOURCE.txt` | vendored meta fixture, sha256 checked by `lane.conformance.test.ts` |

- Calls: SpaceTraders (`SPACETRADERS_BASE_URL`), auth-service `GET /auth/v1/token` and introspect (lane only; 450 ms ceiling).
- Called by: agent-service, fleet-service, navigation-service, auth-service (polls `GET /`).
- Port 3002. Refuses to start without `AUTH_INTROSPECTION_URL`, `AUTH_INTROSPECTION_SECRET`, `AUTH_SERVICE_SHARED_SECRET`.
- Dockerfile copies both `tsconfig.json` and `tsconfig.build.json`.
- CI `container.yml`: `test` (typecheck, lint, test), `docker` (main: deploys through agent-service's SSM document). No openapi.json.

## Reference docs

- `README.md` "Credential policy", "Lanes": read when adding a path exception or changing lane derivation.
- `README.md` "Errors the gateway generates itself", "Retry policy", "Configuration": read when adding an error, touching retries, or adding a config value.
