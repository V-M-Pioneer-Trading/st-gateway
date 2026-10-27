# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo.

- **Role**: backend (Node / TS / Express). Global SpaceTraders rate budget, agent-token injection, retries, lanes
- **Backend paths**: `src/`, `Dockerfile`
- **Shared paths** (only the owner named in the task edits them): `src/__tests__/fixtures/introspection.json` and its `SOURCE.txt` (sha256 pinned)
- **Worktree setup**: `npm ci --no-audit --no-fund`
- **Checks** (validator runs every one, in order):
  1. `npm audit --audit-level=high`
  2. `npm run typecheck --silent`
  3. `npm run lint --silent`
  4. `npm test --silent -- --silent`
- **Security**: no secret scan runs yet: gitleaks is not installed and no pre-commit hook exists (planned: `gitleaks git --pre-commit --staged` in `.git/hooks/pre-commit`), so check every diff for secrets by eye · dependency audit in checks
- **Coding standards**: `CLAUDE.md` in this repo; lint rules come from `@v-m-pioneer-trading/eslint-config` and change only by a release of that package
- **Risk areas** (validator reviews diffs touching these on Opus). Highest-risk service:
  - agent-token handling (`src/authServiceClient.ts`, injection in `src/server.ts`): reaches SpaceTraders only, never a log
  - `src/tokenBucket.ts` and retry rules: a POST retried on 5xx can double-buy; every upstream fetch acquires the bucket, retries included
  - `/register`: forwards the account token
  - lane derivation: through clerk-client's deriver only; a caller never declares priority
  - `.github/workflows/`: push to main deploys production (through agent-service's SSM document)
- **Contracts**:
  - `/proxy/<path>`, `/health`, `/metrics` JSON shape, `{error:{message}}` envelope: provider this repo; consumers agent, fleet, navigation, auth-service. No `openapi.json` yet (V-M-Pioneer-Trading/meta#102)
  - upstream-error answers (`meta/docs/design/upstream-errors.md`, `meta/fixtures/gateway-errors.json`): this repo's behaviour, fixture owned by meta
  - `meta/fixtures/introspection.json`, vendored in `src/__tests__/fixtures/`: provider meta; change meta first, then re-vendor
  - `@v-m-pioneer-trading/eslint-config`, `@v-m-pioneer-trading/clerk-client`: consumed by release-tarball URL, so a change is a version bump here
