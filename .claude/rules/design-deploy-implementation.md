# Deploy — Implementation (shipped)

Deploy adapter v1 shipped 2026-05-14 ([#203](https://github.com/gazetta-studio/gazetta-studio/issues/203)). See [`design-deploy.md`](design-deploy.md) for the durable design + [`docs/adr/0010-deploy-publish-independence.md`](../../docs/adr/0010-deploy-publish-independence.md) for the load-bearing decisions + [`docs/deploy.md`](../../docs/deploy.md) for the operator guide.

Cut-by-cut history recoverable from `git log --grep "Cut.*of #203"`.

## What shipped

- `DeployAdapter` Pattern 1 Provider surface + `WorkerCapableDeployAdapter` capability extension + error taxonomy
- `cloudflareWorkersDeploy()` factory (refactor of the previous hardcoded `gazetta deploy` flow)
- Two validators: `deploy-target-type-supported` (error severity, enforces target-type compatibility) + `target-deploy-coverage` (info severity, surfaces capability gap for container-served targets)
- `target.worker` field deleted; replaced by `target.deploy?: DeployAdapter`
- Operator docs (`docs/deploy.md`) + sweep of stale `target.worker` references across `.claude/rules/` and `docs/`

End-to-end verified against `sites/gazetta.studio`: `gazetta publish production` writes to R2; `gazetta deploy production` deploys the worker; site live at https://gazetta.studio.

## Deferred items

| Item | Trigger to revisit |
|---|---|
| `cloudflarePagesDeploy` ([#204](https://github.com/gazetta-studio/gazetta-studio/issues/204)) | Next in Onboarding sprint |
| `vercelEdgeDeploy` ([#206](https://github.com/gazetta-studio/gazetta-studio/issues/206)) | Onboarding sprint |
| `netlifyStaticDeploy` ([#209](https://github.com/gazetta-studio/gazetta-studio/issues/209)) | Onboarding sprint |
| `cloudflarePagesStaticDeploy` ([#210](https://github.com/gazetta-studio/gazetta-studio/issues/210)) | Demand-driven; Tier 2 |
| `netlifyEdgeDeploy` ([#207](https://github.com/gazetta-studio/gazetta-studio/issues/207)) | Demand-driven; Tier 2 |
| `denoDeployDeploy` ([#205](https://github.com/gazetta-studio/gazetta-studio/issues/205)) | Demand-driven; Tier 2 |
| `githubPagesDeploy` ([#208](https://github.com/gazetta-studio/gazetta-studio/issues/208)) | Demand-driven; Tier 2 |
| `s3StaticDeploy` ([#211](https://github.com/gazetta-studio/gazetta-studio/issues/211)) | Demand-driven; Tier 2 |
| `azureBlobStaticDeploy` ([#212](https://github.com/gazetta-studio/gazetta-studio/issues/212)) | Demand-driven; Tier 2 |
| Container deployment guide ([#213](https://github.com/gazetta-studio/gazetta-studio/issues/213)) | Onboarding sprint (parallel) |
| First-run Cloudflare setup ([#214](https://github.com/gazetta-studio/gazetta-studio/issues/214)) | Onboarding sprint |
| `action: 'deploy'` audit event | Compliance ask OR 3+ operator requests |
| `beforeDeploy` / `afterDeploy` hooks | First concrete consumer with use case CI-step can't handle |
| `gazetta deploy --dry-run` | Operator request |
| Multi-adapter composition (`deployChain([...])`) | 3+ operators report needing deploy + purge CDN + notify Slack pattern |
| Container deploy adapters | **Permanent shape decision** per ADR-0010 — NOT on the trigger list |
| Adapter discovery + scaffolding | 5+ npm-distributed deploy adapters ship |
| Rate limiting / queueing concurrent deploys | Platform that doesn't queue causes issues |
| Per-locale / per-region multi-deploy | Real demand; today's per-domain target pattern covers most cases |

## Lessons learned

Surprises surfaced during implementation that the design pass didn't predict; captured here so future feature work doesn't re-discover them:

1. **`TargetType` enum hadn't been widened to three values yet.** The design doc named `'static' | 'esi' | 'dynamic'` per the locked `design-rendering.md` Q1 taxonomy, but `design-rendering.md` Cut 1 (the enum split) hadn't shipped. Adapters declaring `supports: ['esi'] as const` failed type-check. Resolved by declaring `supports: ['dynamic']` today with a forward-compat note in `design-deploy.md` — additive widening when the rendering Cut 1 lands. **Pattern: when a design depends on another design's implementation, declare the dependency + ship against the current enum + document the additive migration path.**

2. **`tsc --noEmit` is not full build verification.** Cut 3a's `supports: ['esi']` was clean under `tsc --noEmit` but failed `npm run build`. The emit path runs additional checks that `--noEmit` suppresses. Now documented in CLAUDE.md: prefer `npm run build` after type-shape changes. **Pattern: surface this in the build-test guide so future Claude sessions don't repeat the gap.**

3. **`tsc -b` from a workspace dir spilled 1770 artifacts** beside source `.ts` files across the monorepo. Walked build references up to root tsconfig + emitted next to source. Now documented in CLAUDE.md: never `tsc -b` from inside a workspace. **Pattern: subtle CLI gotchas earn explicit warnings in build-test sections.**

4. **Wrangler 4.x stdout opens with a telemetry banner URL.** The first regex match `https://[^\s]+` captured `github.com/cloudflare/workers-sdk/.../telemetry.md` instead of the deploy URL. Fixed with `extractDeployUrl()` pure helper that prefers `target.siteUrl` match, falls through to `*.workers.dev`, then to any non-github URL. Unit-tested. **Pattern: external CLI output formats drift; defensive parsing with explicit priority order + unit tests beats greedy regex.**

5. **Locale-variant publish output not gitignored.** Existing patterns covered `index.html` and `.{hash}.hash` but missed `index.{loc}.html` and `.{hash}.hash.{loc}`. 8 untracked files leaked into the working tree on every starter publish. Fixed in `.gitignore`. **Pattern: locale-variant suffixes need their own gitignore line when the parent shape is ignored.**

6. **Site-local `.env` discovery + config-eval timing.** Sites carry their own `.env` (e.g., `sites/gazetta.studio/.env` with R2 creds). The CLI loaded env AFTER `resolveTarget()` triggered config-eval, so factories threw on missing env vars even when the file existed. Fixed by hoisting env-load to a single dispatch at the top of `main()` via `resolveSiteDirForCommand()` (pure-fs dispatch table). Shipped separately as PR #371; landed on main before #367 merge. **Pattern: when config-eval depends on env vars, env-load must precede config-eval — verify with an explicit ordering test, not assumption.**

7. **CLI dispatch was duplicating `resolveSiteDir` + `loadEnvFiles` across 7 branches.** Refactored to one up-front dispatch (`resolveSiteDirForCommand`) + one env-load callsite. **Pattern: when an env-init step needs to run for every command branch, extract a single dispatch table; don't replicate the call across branches.**
