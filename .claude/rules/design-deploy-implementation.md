# Deploy — Implementation

Companion to [`design-deploy.md`](design-deploy.md). 4-cut sequence for the v1 contract + Cloudflare refactor. Downstream adapters (#204, #206, #208, #209, #205, #207, #210, #211, #212) each ship as their own small PRs after this contract lands.

See [`design-deploy.md`](design-deploy.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `deploy-contract-v1` off `main`. Hard cutover per ADR-0005 + ADR-0008 precedent — `target.worker` deleted in Cut 3; no coexistence period. Each cut is independently revertable per [team-preferences rule 17](team-preferences.md).

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `DeployAdapter` interface + `WorkerCapableDeployAdapter` capability + types/schemas | ☐ | Low | Type contract |
| 2 | `deploy-target-type-supported` + `target-deploy-coverage` validators | ☐ | Low-medium | Validation framework integration |
| 3 | `cloudflareWorkersDeploy()` factory + refactor [cli/index.ts:1230-1314](../../packages/gazetta/src/cli/index.ts) + delete `WorkerConfig` + migrate fixture configs | ☐ | Medium-high | First real adapter; load-bearing |
| 4 | Real-Cloudflare smoke test (opt-in via `DEPLOY_E2E=cloudflare` env) + docs (`docs/deploy.md`, `docs/cloudflare.md` updates) + ADR-0010 | ☐ | Low | End-to-end validation + user-facing |

**Total estimate: ~5-6 days for the v1 cutover.**

## Per-cut scope

### Cut 1: `DeployAdapter` interface + capability extension

**Files added:**
- `packages/gazetta/src/deploy/types.ts` — `DeployAdapter`, `WorkerCapableDeployAdapter`, `DeployContext`, `ValidateContext`, `DeployResult`, `WorkerRuntimeConfig`
- `packages/gazetta/src/deploy/errors.ts` — `DeployError`, `DeployConfigError`, `DeployAuthError`, `DeployTransportError`, `DeployContentError`
- `packages/gazetta/src/deploy/index.ts` — barrel export

**Files modified:**
- `packages/gazetta/src/types.ts` — add `TargetConfig.deploy?: DeployAdapter`
- `packages/gazetta/src/config/schemas.ts` — `targetSchema.deploy` is `z.unknown()` (factory result; not Zod-validated; per Path X pattern)
- `packages/gazetta/src/index.ts` — re-export types from `deploy/`

**Tests:**
- Type-equality tests in `packages/gazetta/tests/deploy-types.test.ts`:
  - `expectTypeOf<TargetConfig['deploy']>().toEqualTypeOf<DeployAdapter | undefined>()`
  - `expectTypeOf<WorkerCapableDeployAdapter>().toMatchTypeOf<DeployAdapter>()` (LSP check)
- Error class hierarchy: each `DeployError` subclass inherits + carries `adapter` field

**Risk:** low. Pure type + schema work; no runtime behavior. Reverting one commit rolls back.

**SOLID:**
- SRP per file (types / errors separated)
- ISP — `DeployAdapter` is narrow (name + supports + execute + optional validate); `WorkerCapableDeployAdapter` is the capability extension for worker-bundling adapters
- LSP — `WorkerCapableDeployAdapter extends DeployAdapter`; substitutable wherever the base is expected
- DIP — consumers depend on `DeployAdapter` interface; concretions injected via factories (Cut 3)

### Cut 2: Validators

**Files added:**
- `packages/gazetta/src/validation/validators/deploy-target-type-supported.ts` — error severity; runs at `cli` + `pre-publish` stages. Reads `target.deploy?.supports` and `target.type`; reports mismatch with adapter name + supported list.
- `packages/gazetta/src/validation/validators/target-deploy-coverage.ts` — info severity; runs at `cli` stage only. Reports when target has runtime constraints (`type: 'esi'` or `'dynamic'`) + no `deploy:` field configured + storage isn't `filesystemStorage` (the dev / `gazetta serve` shape that doesn't need a deploy adapter).

**Files modified:**
- `packages/gazetta/src/validation/default-registry.ts` — register the two new validators
- Existing pre-publish gate integration in `packages/gazetta/src/admin-api/routes/publish.ts` — `deploy-target-type-supported` flows through automatically once registered

**Tests:**
- `packages/gazetta/tests/validation-deploy-target-type-supported.test.ts`:
  - `type: 'esi'` + adapter `supports: ['static']` → error
  - `type: 'static'` + adapter `supports: ['static']` → ok
  - `type: 'static'` + adapter `supports: ['static', 'esi']` → ok
  - No `target.deploy` → validator skips (no issue)
- `packages/gazetta/tests/validation-target-deploy-coverage.test.ts`:
  - `type: 'esi'` + no `deploy:` + `r2Storage` → info issue
  - `type: 'esi'` + no `deploy:` + `filesystemStorage` → no issue (probably `gazetta serve` self-hosted)
  - `type: 'static'` + no `deploy:` + `filesystemStorage` → no issue (local target)
  - `type: 'esi'` + has `deploy:` → no issue

**Risk:** low-medium. New validators slot into existing registry; the filesystem-storage heuristic in `target-deploy-coverage` could false-negative (e.g., production filesystem on a VPS). Acceptable v1 trade-off; refine if operators report false negatives.

**SOLID:**
- SRP per validator (each owns one rule)
- OCP — new validators slot into existing registry without changing orchestrator code
- DIP — validators depend on the `Validator` interface, not on specific adapter types

### Cut 3: `cloudflareWorkersDeploy()` + CLI refactor + delete `WorkerConfig`

This is the load-bearing cut. Three concerns in one commit because they're inseparable — refactoring the CLI requires the factory; deleting `WorkerConfig` requires the CLI refactor; the factory is meaningless without the CLI integration.

**Files added:**
- `packages/gazetta/src/deploy/cloudflare-workers.ts` — `cloudflareWorkersDeploy(opts: CloudflareWorkersDeployOptions): WorkerCapableDeployAdapter`. Internal: lifts the wrangler.toml generation + `npx wrangler deploy` shell-out from `cli/index.ts:1230-1314`. Exposes `workerRuntimeConfig()` returning `{ bucketBinding: 'SITE_BUCKET', routes: [{ pattern, zone }] }` when `siteUrl` is set.
- `packages/gazetta/tests/deploy-cloudflare-workers.test.ts` — unit tests with mocked `execSync` + `writeFile`. Validates:
  - `apiToken` missing → `DeployConfigError` at construction
  - `accountId` missing → `DeployConfigError` at construction
  - `execute()` shells out to wrangler in a tmpdir; cleans up on success
  - `execute()` cleans up tmpdir on failure
  - `validate?` returns empty when config is complete; returns issue when `bucket` collides with reserved names
  - `workerRuntimeConfig()` returns the right shape from constructed config
  - `supports === ['esi']` (v1; `dynamic` reserved for v2)

**Files modified:**
- `packages/gazetta/src/cli/index.ts` — `runDeploy(siteDir, targetName)` rewrites:
  - Load site, resolve target
  - Error if `target.deploy` is unset (new error message per design doc)
  - Construct `DeployContext` from target + storage + env + logger + signal
  - `await target.deploy.execute(ctx)`
  - Surface result.url / result.details on success; surface DeployError class + message on failure
  - DELETE the entire wrangler.toml generation + execSync block (now lives in the adapter)
- `packages/gazetta/src/types.ts` — DELETE `WorkerConfig` interface; DELETE `TargetConfig.worker` field
- `packages/gazetta/src/config/schemas.ts` — DELETE `workerSchema`; drop `worker` from `targetSchema`
- `packages/gazetta/src/index.ts` — export `cloudflareWorkersDeploy`
- `packages/gazetta/src/build.ts` (or wherever `gazetta build` lives) — when generating worker code, detect `'workerRuntimeConfig' in target.deploy` and read the runtime config from there instead of reading `target.worker`. Falls back gracefully when adapter doesn't have the capability.

**Fixture migrations:**
- `examples/starter/sites/main/site.config.ts` — if it has a Cloudflare target, migrate
- `sites/gazetta.studio/site.config.ts` — migrate the production target
- `tests/fixtures/sites/target-matrix/sites/main/site.config.ts` — migrate Cloudflare entries
- `packages/gazetta/tests/fixtures/configs/*/site.config.ts` — migrate any with `worker:` blocks
- `tests/_helpers/starter.ts` — update if it constructs Cloudflare targets

**Tests:**
- All existing `runDeploy` tests (if any) rewritten against the new flow
- Integration test: `loadSite` with migrated fixture + `runDeploy` → mocked-wrangler success path

**Risk:** medium-high. This is the load-bearing cut — every Cloudflare-target operator's config breaks until they migrate. Per ADR-0005's hard-cutover precedent.

Tight scope discipline: the cut does ONLY the contract refactor + Cloudflare adapter. Doesn't add Pages support, doesn't add Vercel, doesn't add anything else. Those are downstream issues.

**SOLID:**
- SRP — `cloudflareWorkersDeploy` owns ONE concern (Cloudflare Workers deploy); CLI's `runDeploy` owns ONE concern (resolve target + invoke adapter)
- DIP — CLI depends on `DeployAdapter` interface; the adapter is the concrete implementation injected by the operator's factory call

### Cut 4: Smoke test + docs + ADR-0010

**Files added:**
- `tests/e2e/deploy-cloudflare.spec.ts` — opt-in via `DEPLOY_E2E=cloudflare` env. Skipped in default CI; runs on operator's local machine or scheduled smoke job. Deploys a fixture site to a real Cloudflare Workers test account; asserts response from deployed URL.
- `docs/deploy.md` (NEW) — operator guide:
  - `target.deploy` field shape
  - Per-adapter sections (just Cloudflare Workers in v1; future adapters add sections here as they ship)
  - Credentials handling
  - `gazetta deploy` command behavior
  - Common error messages + fixes
  - Migration from `target.worker`
- `docs/adr/0010-deploy-publish-independence.md` (NEW) — see "ADR-0010" section below
- `CLAUDE.md` — link `docs/deploy.md` from the "Public docs" section

**Files modified:**
- `docs/cloudflare.md` — add a "Deploy adapter" section linking to `docs/deploy.md`; remove the now-obsolete `worker: { type: 'cloudflare', ... }` example; add the `cloudflareWorkersDeploy({...})` example
- `.claude/rules/configurations.md` — update target config example
- `.claude/rules/hosting.md` — update Cloudflare section
- `.claude/rules/operations.md` — note about the deploy adapter pattern
- `.claude/rules/cli.md` — update `gazetta deploy` section to reflect "adapter resolves the platform"
- `.claude/rules/architecture.md` — add deploy adapter to the package layer description
- `.claude/rules/design-decisions.md` — add an entry covering deploy boundary (or this could be ADR-0010 only; pick at PR time)
- `.claude/rules/feature-design-process.md` — add Deploy to the foundational dimensions / non-foundational disciplines tables where appropriate (mention as a reference doc analog to design-config / design-logging)
- `ROADMAP.md` — mark #203 as shipped; update Onboarding sprint status
- `CHANGELOG.md` (if it exists) — "Breaking: `target.worker` deleted; replaced with `target.deploy` accepting a factory call. Migrate Cloudflare configs per `docs/deploy.md`."

**Tests:** None directly; manual review of examples for correctness.

**Risk:** low. Mechanical doc work after the code stabilizes.

**SOLID:** N/A for docs.

## Validation gate (definition of done)

- [ ] All 4 cuts merged
- [ ] `examples/starter` deploys successfully via `npx gazetta deploy production` against a fresh Cloudflare account (manual smoke)
- [ ] No public exports of `WorkerConfig` (deleted in Cut 3)
- [ ] `docs/deploy.md` covers operator setup end-to-end
- [ ] ADR-0010 documents the load-bearing decisions
- [ ] CHANGELOG entry covers the breaking change

## Deferred items

| Item | Trigger to revisit |
|---|---|
| `cloudflarePagesDeploy` ([#204](https://github.com/gazetta-studio/gazetta-studio/issues/204)) | Next in Onboarding sprint after v1 contract lands |
| `vercelEdgeDeploy` ([#206](https://github.com/gazetta-studio/gazetta-studio/issues/206)) | Onboarding sprint |
| `netlifyStaticDeploy` ([#209](https://github.com/gazetta-studio/gazetta-studio/issues/209)) | Onboarding sprint |
| `cloudflarePagesStaticDeploy` ([#210](https://github.com/gazetta-studio/gazetta-studio/issues/210)) | Demand-driven; Tier 2 |
| `netlifyEdgeDeploy` ([#207](https://github.com/gazetta-studio/gazetta-studio/issues/207)) | Demand-driven; Tier 2 |
| `denoDeployDeploy` ([#205](https://github.com/gazetta-studio/gazetta-studio/issues/205)) | Demand-driven; Tier 2 |
| `githubPagesDeploy` ([#208](https://github.com/gazetta-studio/gazetta-studio/issues/208)) | Demand-driven; Tier 2 |
| `s3StaticDeploy` ([#211](https://github.com/gazetta-studio/gazetta-studio/issues/211)) | Demand-driven; Tier 2 |
| `azureBlobStaticDeploy` ([#212](https://github.com/gazetta-studio/gazetta-studio/issues/212)) | Demand-driven; Tier 2 |
| Container deployment guide ([#213](https://github.com/gazetta-studio/gazetta-studio/issues/213)) | Onboarding sprint (parallel to this contract) |
| First-run Cloudflare setup ([#214](https://github.com/gazetta-studio/gazetta-studio/issues/214)) | Onboarding sprint |
| `action: 'deploy'` audit event | Compliance ask OR 3+ operator requests |
| `beforeDeploy` / `afterDeploy` hooks | First concrete consumer with use case CI-step can't handle |
| `gazetta deploy --dry-run` | Operator request |
| Multi-adapter composition (`deployChain([...])`) | 3+ operators report needing deploy + purge CDN + notify Slack pattern |
| Container deploy adapters | Permanent shape decision per ADR-0010 — NOT on the trigger list |
| Adapter discovery + scaffolding | 5+ npm-distributed deploy adapters ship |
| Rate limiting / queueing concurrent deploys | Platform that doesn't queue cause issues |
| Per-locale / per-region multi-deploy | Real demand; today's per-domain target pattern covers most cases |

## Open implementation questions

1. **`WorkerRuntimeConfig` shape** — Cut 1 locks `{ bucketBinding, routes?, bindings? }`. The `bindings?: Record<string, unknown>` field is the escape hatch for adapter-specific extras (Cloudflare KV, D1, Queues, etc.). Need to validate at Cut 3 that the existing wrangler.toml generation maps cleanly to this shape; tighten or widen the type if mismatches surface.

2. **Tmpdir cleanup on signal abort** — current code uses `try/finally` to clean up. With `AbortSignal` in the contract, mid-deploy abort needs cleaner semantics. v1 best-effort: signal forwarded to execSync via the spawn options; tmpdir cleanup runs in `finally` regardless.

3. **Logger module name format** — `cli.deploy.{adapter-name}`. Need to confirm the adapter-name convention — should `cloudflareWorkersDeploy` adapter's `name` field be `'cloudflare-workers'` (kebab-case) or `'cloudflareWorkers'` (matches factory name)? Recommend kebab-case to match the existing `module:` convention in `design-logging.md` (`cache.memory`, `storage.r2`).

4. **`gazetta build` worker-config detection** — `'workerRuntimeConfig' in target.deploy` is a runtime check. Could be a type guard `isWorkerCapable(adapter)` for cleaner DX. Decide at Cut 3.

5. **Migration of test fixtures with disabled Cloudflare targets** — some fixtures may have `worker: { ... }` blocks that aren't exercised by tests. Audit at Cut 3 — delete unused fixtures or migrate them all.

## Test infrastructure

- **Mocked-wrangler tests** (Cut 3): `vi.mock('node:child_process')` to intercept `execSync` calls. Validates that wrangler.toml is written correctly + the expected command is invoked, without actually deploying.
- **Real-Cloudflare smoke** (Cut 4): opt-in via `DEPLOY_E2E=cloudflare` env. Requires a real Cloudflare account with API token. Not gating CI; runs on demand or in a scheduled job.
- **Property tests for the validator** (Cut 2): every target type × every adapter `supports` value combination produces deterministic validator output.

## Estimates

Wall-clock for solo dev:

| Cut | Estimate |
|---|---|
| 1 (Interface + types) | 0.5 day |
| 2 (Validators) | 1 day |
| 3 (Cloudflare refactor + delete WorkerConfig + fixture migration) | 2-3 days |
| 4 (Smoke + docs + ADR) | 1.5 days |

**Total: ~5-6 days.** With CI iteration + review feedback + the typical "first migration touches more places than expected," budget ~1.5-2 weeks.

## SOLID checks per cut

- **Cut 1**: ISP — `DeployAdapter` is narrow; `WorkerCapableDeployAdapter` extension keeps worker-bundling out of the base contract. LSP — every adapter implementing the base is substitutable. SRP per file.
- **Cut 2**: SRP per validator. OCP — new validators slot into the registry without changing orchestrator. DIP — validators depend on the `Validator` interface, not on adapter implementations.
- **Cut 3**: SRP — adapter owns Cloudflare deploy mechanics; CLI owns invocation. DIP — CLI depends on `DeployAdapter`, not on `cloudflareWorkersDeploy`. LSP — future Cloudflare-related adapters (Pages + Functions, Pages plain-static) substitute cleanly.
- **Cut 4**: N/A (docs).

Any cut failing SOLID review at PR time is a structural correction (per [team-preferences rule 18](team-preferences.md)), not a patch.

## ADR-0010

Lands with Cut 4 (or earlier if Cut 1 review surfaces ADR-worthy concerns).

Captures four interlocking decisions per `feature-design-process.md`'s ADR criteria (hard to reverse + surprising without context + real trade-off):

1. **Publish and deploy are independent operations** (Q4 revised) — surprising vs Vercel/Netlify Jamstack norms.
2. **`target.worker` deleted; deploy adapter owns runtime metadata via `WorkerCapableDeployAdapter` capability** (Q1) — hard to reverse migration.
3. **`storage:` always required; `deploy:` optional and additive** (Q3) — surprising vs CMSes that bundle them.
4. **No container deploy adapters** (Q6) — permanent shape; surprising vs operator expectations from Jamstack tools.

The ADR's "Decision" section names all four; "Consequences" covers the migration cost, the four foundational checks that compose with the boundary, and the future directions that respect the locked shape.
