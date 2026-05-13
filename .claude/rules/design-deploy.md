# Deploy

How operators deploy Gazetta to edge platforms and static hosts. `DeployAdapter` is the Pattern 1 Provider surface (per [ADR-0008](../../docs/adr/0008-provider-factory-returns-instance.md)) that swaps platform-specific deploy mechanics behind a uniform contract.

**Status**: design pass complete (2026-05). Reference doc. Implementation phases sit in the Onboarding sprint (Tier 1 per [ROADMAP.md](../../ROADMAP.md)). Closes [#203](https://github.com/gazetta-studio/gazetta-studio/issues/203).

**Companion docs**:
- [`design-deploy-implementation.md`](design-deploy-implementation.md) — 4-cut sequence for the v1 contract + Cloudflare refactor. Downstream adapters (#204, #206, #208, #209, etc.) each ship as their own small PRs after the contract lands.
- [`docs/adr/0010-deploy-publish-independence.md`](../../docs/adr/0010-deploy-publish-independence.md) — the load-bearing decisions: independent publish/deploy operations, `deploy:` field separate from `storage:`, no container adapters, `target.worker` deleted in favor of the adapter owning runtime metadata.
- [`design-provider-config.md`](design-provider-config.md) — Pattern 1 (single-axis direct factory at field); same shape as `storage:`, `transforms:`, `cache:`.
- [`design-rendering.md`](design-rendering.md) — Q6 deployment matrix (target type × platform × worker location × origin location) that adapters declare compatibility against.
- [`design-validation.md`](design-validation.md) — `Issue[]` shape that `validate?(ctx)` returns; deploy validators flow through the standard CLI + pre-publish gate.

## Scope

**In v1:**
- `DeployAdapter` interface (Pattern 1 Provider per ADR-0008)
- `target.deploy?: DeployAdapter` field (optional)
- `WorkerCapableDeployAdapter` capability interface for adapters that bundle worker code (Cloudflare Workers, Cloudflare Pages with Functions, Vercel Edge, Netlify Edge, Deno Deploy)
- `cloudflareWorkersDeploy()` factory — refactor of the existing hardcoded `gazetta deploy` flow in [cli/index.ts:1230-1314](../../packages/gazetta/src/cli/index.ts)
- `target.worker` field deleted (hard cutover per ADR-0005 precedent)
- Two validators: `deploy-target-type-supported` (error severity, enforces target-type compatibility from Q5) + `target-deploy-coverage` (info severity, surfaces missing-deploy on runtime-requiring targets that don't use container-served `gazetta serve`)
- Independent publish/deploy operations: no CLI gate between them

**Out of v1 (downstream issues, ship after contract lands):**
- `cloudflarePagesDeploy()` ([#204](https://github.com/gazetta-studio/gazetta-studio/issues/204)) — CF Pages + Functions
- `vercelEdgeDeploy()` ([#206](https://github.com/gazetta-studio/gazetta-studio/issues/206)) — Vercel Edge Functions
- `netlifyStaticDeploy()` ([#209](https://github.com/gazetta-studio/gazetta-studio/issues/209)) — Netlify static
- `cloudflarePagesStaticDeploy()` ([#210](https://github.com/gazetta-studio/gazetta-studio/issues/210)) — CF Pages plain static
- `netlifyEdgeDeploy()` ([#207](https://github.com/gazetta-studio/gazetta-studio/issues/207)) — Netlify Edge Functions
- `denoDeployDeploy()` ([#205](https://github.com/gazetta-studio/gazetta-studio/issues/205)) — Deno Deploy
- `githubPagesDeploy()` ([#208](https://github.com/gazetta-studio/gazetta-studio/issues/208)) — GitHub Pages
- `s3StaticDeploy()` ([#211](https://github.com/gazetta-studio/gazetta-studio/issues/211)) — S3 static website
- `azureBlobStaticDeploy()` ([#212](https://github.com/gazetta-studio/gazetta-studio/issues/212)) — Azure Blob static website
- Container guide ([#213](https://github.com/gazetta-studio/gazetta-studio/issues/213)) — Fly.io / Cloud Run / Railway / Render recipes for `gazetta serve` in a container
- First-run Cloudflare setup ([#214](https://github.com/gazetta-studio/gazetta-studio/issues/214))

**Non-goals:**
- Container deploy adapters (`flyDeploy()`, `cloudRunDeploy()`, etc.) — permanent shape decision; container deploys use platform CLIs from CI or local machine; `gazetta serve` is the runtime inside the container. See ADR-0010.
- Audit event for `gazetta deploy` invocation — logs side, not audit side. Trigger to revisit: compliance ask or 3+ operator requests.
- `beforeDeploy` / `afterDeploy` hooks — no first consumer to drive the contract shape; deferred to v1.5+. CI-step workaround covers known use cases.
- `gazetta deploy --dry-run` — premature; ship if operators ask. Adapter's `validate?` already covers config-correctness pre-flight.
- Wrapping platform CLIs that already do the job well (Wrangler, gcloud, flyctl, vercel) beyond what's needed for Gazetta-specific value (validation, sensible defaults, target-type compatibility checks).

## The contract

### `DeployAdapter` interface

```ts
export interface DeployAdapter {
  /** Stable identifier for diagnostics, logs, validation messages. */
  readonly name: string

  /** Which target types this adapter supports. Validated at config-eval +
   *  enforced by the `deploy-target-type-supported` validator. */
  readonly supports: readonly TargetType[]

  /** Run the deploy. Throws DeployError variants on failure;
   *  returns DeployResult on success. */
  execute(ctx: DeployContext): Promise<DeployResult>

  /** Optional pre-flight validation: cross-field invariants beyond
   *  target-type compatibility (e.g., "Cloudflare Workers requires
   *  bucket binding"). Runs at `cli` + `pre-publish` stages of the
   *  validation framework. Returns standard Issue[] shape. */
  validate?(ctx: ValidateContext): Issue[]
}

export interface DeployContext {
  /** The resolved target being deployed. */
  target: TargetConfig
  /** Target name from site.config.ts. */
  targetName: string
  /** Path to pre-rendered output (static + esi targets). Adapters that
   *  need bytes read from this path; adapters that don't (worker-only
   *  deploys to platforms reading from external storage at request time)
   *  ignore it. */
  outputDir: string
  /** The target's StorageProvider. Adapters that read content during
   *  deploy use this; adapters that don't ignore it. */
  storage: StorageProvider
  /** process.env passthrough. Adapters read platform-specific env vars
   *  (CLOUDFLARE_API_TOKEN, VERCEL_TOKEN, etc.) per their own
   *  documentation. */
  env: Record<string, string | undefined>
  /** Module-scoped logger per design-logging.md. */
  logger: Logger
  /** Cancellation signal for long-running deploys. */
  signal: AbortSignal
}

export interface ValidateContext {
  target: TargetConfig
  targetName: string
  site: SiteManifest
}

export interface DeployResult {
  /** Deployed URL when known. Wrangler returns one; some platforms
   *  don't surface a URL until DNS propagates. */
  url?: string
  /** Adapter-specific extras (Cloudflare worker version ID, Netlify
   *  deploy ID, etc.). Surfaced in CLI output for operator inspection. */
  details?: Record<string, unknown>
}
```

### Capability extension: `WorkerCapableDeployAdapter`

Some adapters bundle worker code (Cloudflare Workers, Cloudflare Pages + Functions, Vercel Edge, Netlify Edge, Deno Deploy). The `gazetta build` command needs runtime metadata (bucket binding name, worker entry point, route patterns) from these adapters. The capability interface surfaces it without polluting the base contract.

```ts
export interface WorkerCapableDeployAdapter extends DeployAdapter {
  /** Returns the worker runtime config that `gazetta build` needs to
   *  generate the worker code (R2 bucket binding name, route patterns,
   *  KV bindings, etc.). Called at build time, not at execute time. */
  workerRuntimeConfig(): WorkerRuntimeConfig
}

export interface WorkerRuntimeConfig {
  /** Binding name for the worker's storage access (e.g., 'SITE_BUCKET'
   *  for the R2 binding). */
  bucketBinding: string
  /** Route patterns the worker should handle. */
  routes?: readonly { pattern: string; zone?: string }[]
  /** Additional adapter-specific bindings (KV, D1, Queues). */
  bindings?: Record<string, unknown>
}
```

`gazetta build` detects worker-capable adapters via `'workerRuntimeConfig' in target.deploy` and reads the config. Static-only adapters (GitHub Pages, S3 static, Netlify static, CF Pages plain-static) don't implement this interface.

### Error taxonomy

```ts
export class DeployError extends Error {
  constructor(message: string, public adapter: string) { super(message) }
}

export class DeployConfigError extends DeployError {
  /** Raised at factory construction; missing required fields,
   *  malformed env-var sentinels. Operator-input validation. */
}

export class DeployAuthError extends DeployError {
  /** Raised at execute() when platform rejects credentials. */
}

export class DeployTransportError extends DeployError {
  /** Raised at execute() when network/platform-SDK call fails. */
}

export class DeployContentError extends DeployError {
  /** Raised at execute() when adapter expects published content but
   *  target storage is empty. Adapter's responsibility (per Q4 lock —
   *  CLI doesn't gate this). */
}
```

Each adapter implementation translates platform-SDK errors into these classes. The CLI catches `DeployError` and surfaces the `adapter` field + a human-readable message; debug logs include the underlying cause.

## Operator surface

### `target.deploy` field

```ts
import { defineSite, r2Storage, cloudflareWorkersDeploy } from 'gazetta'

export default defineSite({
  name: 'My Site',
  targets: {
    local: {
      type: 'static',
      storage: filesystemStorage({ path: './dist/local' }),
      // no deploy: — local target serves via `gazetta dev` / `gazetta serve`
    },
    production: {
      type: 'esi',
      storage: r2Storage({
        bucket: 'my-site',
        accountId: process.env.R2_ACCOUNT_ID!,
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
      siteUrl: 'https://my-site.com',
      deploy: cloudflareWorkersDeploy({
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
        name: 'my-site',
        bucket: 'my-site',
      }),
    },
  },
})
```

The `deploy:` field carries a factory call returning a `DeployAdapter` instance (Path X / ADR-0008). Per `target.storage` and other Provider surfaces, the field's type is the runtime interface; the field's value IS the constructed instance.

### CLI: `gazetta deploy [target]`

```bash
gazetta deploy production       # runs target.deploy.execute(ctx)
gazetta deploy staging          # for another target
```

Behavior:
- Auto-detects site + target (first target if not specified)
- Errors if `target.deploy` is unset: "Target 'production' has no deploy adapter configured. Either add a `deploy:` field to your site.config.ts or use platform-native deploy tooling (see docs/container-deployment.md)."
- Runs `target.deploy.execute(ctx)` with `outputDir` pointing at target storage's published location
- On success: surfaces `result.url` and `result.details`
- On failure: surfaces the `DeployError` class + message; exit code 1
- Independent of `gazetta publish` (per Q4 lock + ADR-0010)

## Independence: deploy and publish

Per ADR-0010, `gazetta publish` and `gazetta deploy` are independent operations. Neither calls the other; neither gates on the other.

```bash
# Operator-driven sequencing
gazetta publish production       # writes bytes to target.storage
gazetta deploy production        # deploys platform glue (worker code, etc.)
```

Different adapters relate to storage differently:
- **Worker-deploy adapters** (Cloudflare Workers, Vercel Edge, Netlify Edge, Deno Deploy) deploy the worker code; bytes were written to `target.storage` by a separate `gazetta publish`. The deploy and the bytes are decoupled — the worker reads bytes at request time from the configured storage.
- **Static-host adapters** (GitHub Pages, Netlify static, S3 static, Azure Blob static, CF Pages plain-static) read from `target.storage` at deploy time (typically `filesystemStorage()` writing to `./dist/{target}`) and push to the platform. The deploy IS the upload.

Both shapes use the same `DeployAdapter` interface; the difference is internal to each adapter's `execute()` method.

## Container deploys (no adapter)

Per ADR-0010, container deploys (Fly.io, Cloud Run, Railway, Render, AWS App Runner, Azure App Service) don't ship as Gazetta adapters. The pattern:

1. Operator writes a `Dockerfile` (or uses the canonical one from [docs/container-deployment.md](../../docs/container-deployment.md)) whose entrypoint is `gazetta serve`
2. CI (or local terminal) runs `flyctl deploy` / `gcloud run deploy` / `railway up` / `render deploy` — Gazetta is never invoked at the deploy step
3. Container starts; `gazetta serve` boots; reads `site.config.ts`; serves the configured target from its `storage:` field

`gazetta serve` is the runtime; platform CLIs handle the orchestration. There's no Gazetta-specific glue to wrap.

`target.deploy` stays unset for container targets. The `target-deploy-coverage` validator emits an info-severity message: "Target 'production-fly' has type: 'esi' but no `deploy:` configured. Container deployments use platform-native tooling; see [docs/container-deployment.md]." Operators dismiss or follow the link.

## Target-type compatibility

Per `design-rendering.md` Q6's deployment matrix, each adapter declares which target types it supports. Adapter `supports` values below assume the post-Cut 1 rendering taxonomy (`'static' | 'esi' | 'dynamic'`); today's `TargetType` enum is `'static' | 'dynamic'` where `'dynamic'` plays the ESI role per `getType()`. Adapters shipping before `design-rendering.md` Cut 1 declare `['dynamic']` and widen to `['esi']` when that cut lands — forward-compatible additive change.

| Adapter | `supports` (post-rendering-Cut-1) | Notes |
|---|---|---|
| `cloudflareWorkersDeploy` | `['esi']` (today: `['dynamic']`) | Worker bundles ESI assembly; future `dynamic` (Workers + Node/Bun origin) deferred to v2 |
| `cloudflarePagesDeploy` | `['static', 'esi']` | Pages for static; Functions add ESI capability |
| `cloudflarePagesStaticDeploy` | `['static']` | Pages without Functions |
| `vercelEdgeDeploy` | `['esi']` | WinterTC; `dynamic` deferred to v2 |
| `netlifyEdgeDeploy` | `['esi']` | Same |
| `netlifyStaticDeploy` | `['static']` | Pure static |
| `denoDeployDeploy` | `['esi']` | WinterTC |
| `githubPagesDeploy` | `['static']` | Pure static |
| `s3StaticDeploy` | `['static']` | Pure static |
| `azureBlobStaticDeploy` | `['static']` | Pure static |

The `deploy-target-type-supported` validator enforces this at:
- `cli` stage (`gazetta validate` reports incompatible combos as errors)
- `pre-publish` stage (Validation Cut 4's pre-publish gate blocks publish on incompatible deploy)

Error message format:
> Target 'production' has `type: 'esi'` but deploy adapter 'github-pages' supports only `['static']`. Either switch to a static-capable adapter or change target type.

## Credentials

Per Q7 lock (matching `design-provider-config.md` + ADR-0004 Universal Provider Requirement #3): adapter-namespaced env vars matching platform SDK conventions. Operators pass via `process.env.X!` in the factory call.

| Platform | Standard env vars |
|---|---|
| Cloudflare | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Vercel | `VERCEL_TOKEN` |
| Netlify | `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID` |
| Deno Deploy | `DENO_DEPLOY_TOKEN` |
| GitHub | `GITHUB_TOKEN` (in Actions) or `GH_TOKEN` (gh CLI) |
| AWS S3 | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Azure Blob | `AZURE_STORAGE_CONNECTION_STRING` |

Each adapter's factory documents which vars it reads in JSDoc. Factories validate presence at construction (throw `DeployConfigError` on missing required fields); bad credentials surface at `execute()` time as `DeployAuthError`.

## Logging and observability

Per `design-logging.md`:
- Adapters use module-scoped logger: `module: 'cli.deploy.{adapter-name}'` (e.g., `cli.deploy.cloudflare-workers`).
- Structured fields per log entry: `targetName`, `adapter`, `durationMs`, `outcome` ('ok' | 'failed').
- Privacy posture: never log env-var values, never log credentials, never log content payloads.
- Errors surface with `err: { name, message, stack? }` — no PII string interpolation.
- `requestId` is per-`gazetta deploy` invocation (CLI generates one at command entry); ties together all log entries from the deploy.

No audit event in v1 (per Q9 lock). Operators investigating "when was production deployed" use platform-native deploy logs (Cloudflare audit log, Vercel deployments page, GitHub Actions workflow runs).

## Distinctive choices

### 1. Publish and deploy are independent

Per ADR-0010 + Q4 revised. The CLI doesn't gate either operation on the other. Adapters that need published content read it themselves and error clearly when it's missing.

**Rejected alternative:** Vercel/Netlify-style "deploy implies publish" (auto-publish first). Hides the two-phase model; surprises operators when `gazetta deploy` re-renders 1000 pages; can't deploy a specific past snapshot.

### 2. `target.worker` deleted; deploy adapter owns runtime metadata

Per ADR-0010 + Q1. The Cloudflare Workers adapter owns both the deploy command (`wrangler deploy`) AND the runtime binding shape (the worker code it generates reads from R2). Bundling them in one factory call is honest — same adapter, same config. Capability interface (`WorkerCapableDeployAdapter`) exposes runtime metadata to `gazetta build` without polluting the base contract.

**Rejected alternatives:**
- **Additive `deploy:` alongside `target.worker`:** two fields doing related things; violates "single canonical syntax" from ADR-0008.
- **`deploy:` replaces `target.worker`; runtime config via `workerRuntimeConfig()` accessor on every adapter:** forces non-worker adapters (GitHub Pages, S3 static) to think about workers. Capability interface is cleaner.

### 3. `storage:` always required; `deploy:` optional and additive

Per Q3. Every target carries `storage:`. `deploy:` is optional. Pure-static hosts wire `filesystemStorage()` + a deploy adapter that reads from it.

**Rejected alternative:** Deploy adapters subsume storage for pure-static hosts. Breaks history's `.gazetta/` namespace invariant (every target needs a real storage location); creates "set storage here but not there" teaching friction.

### 4. No container deploy adapters

Per ADR-0010 + Q6. `gazetta serve` is the runtime; platform CLIs (`flyctl`, `gcloud`, `railway`, `render`) handle the deploy step from CI or local machine. Gazetta is never invoked at deploy time for container hosts.

**Rejected alternatives:**
- **One generic `containerDeploy()`:** 500-LOC switch statement over platform CLIs; SRP violation.
- **Per-platform container adapters (`flyDeploy()`, etc.):** reimplements what `flyctl` already does. Per `team-preferences` rule 18 ("Build structurally right from the start"), wrapping CLIs that already do the job is the "stub-that-throws" anti-pattern.

### 5. Target-type compatibility enforced structurally

Per Q5. Adapter declares `supports: readonly TargetType[]`. Validators enforce at `cli` + `pre-publish` stages. Incompatible combinations are blocked errors, not warnings.

**Rejected alternative:** Mismatches fail at deploy time only. Late failure surface; operator waits for deploy to start before seeing the error.

### 6. No audit event for deploy in v1

Per Q9a. Deploy is operator-tier infrastructure, not content. Platform-native deploy logs are the forensic record. Gazetta logs structurally (per `design-logging.md`) but doesn't audit.

**Trigger to revisit:** Compliance requirement OR 3+ operator requests for "audit log of deploys." `action: 'deploy'` is a closed-enum extension that lands additively.

### 7. No hooks in v1

Per Q9b. `beforeDeploy` / `afterDeploy` hooks deferred until a concrete first consumer drives the contract shape. CI-step workaround covers known use cases (Slack notification, cache warming, pre-deploy validation).

**Trigger to revisit:** First consumer with documented use case that CI-step can't handle cleanly.

## Foundational checks

Provider config is a reference doc, not a foundational dimension. How this design composes with each of the 13 foundational dimensions plus multi-instance discipline:

### Multi-instance discipline

Deploy is a one-shot CLI invocation, typically from CI or a single operator's machine. No long-running process; no cross-instance coordination state. Adapters that need rate limiting / queueing (avoiding concurrent deploys to the same target) rely on the platform's own queueing (Wrangler queues, Vercel queues) — Gazetta doesn't add advisory locking.

### Scale (#1)

Adapter cost scales per-adapter shape:
- Worker-deploy adapters (Cloudflare Workers): O(1) — single worker upload regardless of site size
- Static-upload adapters (GitHub Pages, S3 static): O(N files) — bounded by `target.storage` size; same envelope as `gazetta publish` (5000 pages per `design-scale.md`)
- Not on hot paths — invoked once per deploy, not per request

The `outputDir` passed in `DeployContext` is the target storage's published location; adapter walks it as needed. No new scale concern beyond what publish already handles.

### Locale (#2)

Deploy is locale-agnostic. Adapters deploy whatever the target's `storage:` contains, which already carries per-locale variants per `design-i18n.md`'s file-suffix model. Multi-domain locale strategies (per-domain targets per `design-i18n.md`) deploy each target independently; each target has its own `deploy:` field.

### Themes (#3)

Deploy is theme-agnostic. Pre-rendered output (static + esi) carries the right theme variant per the target's published bytes. Dynamic targets resolve theme at request time (not at deploy time).

### Auth + RBAC (#4)

Deploy is operator-tier shell access; no `Principal` exists at deploy time. The `deploy` capability concept is admin-API surface (per `design-auth-rbac.md`), not CLI. CLI deploy is gated by OS-level access to the project + credentials in env vars.

### Audit (#5)

No audit event for deploy in v1 (per Q9a). Platform-native deploy logs are the forensic record. Adapter emits structured logs per `design-logging.md` for operational signal.

**Future direction:** `action: 'deploy'` with `outcome: 'ok' | 'failed' | 'partial'` and `metadata: { adapter, url?, durationMs, errorClass? }`. Composes with existing audit shape additively when triggered.

### Review workflow (#6)

Review workflow gates content writes (save / publish), not infrastructure operations. `gazetta deploy` doesn't traverse the review state machine.

### Hook (#7)

No hooks in v1 (per Q9b). Future `beforeDeploy` / `afterDeploy` hooks would fire via `design-hooks.md`'s phase model when shipped. Closed-enum extension.

### Rendering (#8)

Adapters declare `supports: readonly TargetType[]` (per Q5). The matrix from `design-rendering.md` Q6 is the source of truth; adapters implement against it; `deploy-target-type-supported` validator enforces compatibility.

### Validation (#9)

Adapter `validate?(ctx): Issue[]` runs at `cli` + `pre-publish` stages per `design-validation.md`'s Validator framework. Two built-in validators:
- `deploy-target-type-supported` (error) — enforces Q5 matrix
- `target-deploy-coverage` (info) — surfaces missing-deploy on runtime-requiring targets

Adapter-specific validation (e.g., "Cloudflare Workers requires bucket binding") lives inside the adapter's `validate?` method.

### Plugin (#10)

Per ADR-0008 + ADR-0009: deploy adapters distribute as npm packages exporting a factory function. Operators import and invoke. No plugin runtime, no `init(api)` lifecycle. Same pattern as storage / transform / cache / AI.

Plugin adapter example:
```ts
import { customPlatformDeploy } from '@example/custom-deploy'

defineSite({
  targets: {
    production: {
      type: 'esi',
      storage: r2Storage({...}),
      deploy: customPlatformDeploy({ apiToken: process.env.CUSTOM_TOKEN! }),
    },
  },
})
```

### Cache (#11)

Deploy doesn't read or write through `AdminCache`. Some adapters may purge platform-side CDN caches as part of `execute()` (Cloudflare cache purge after worker deploy); that's the adapter's concern, not the Gazetta cache framework.

### Offline (#12)

Deploy is online-only. CLI surface; not an editor concern. Operators running offline don't deploy.

### Collaboration (#13)

Deploy is operator-tier; not surfaced to authors via comments / mentions / activity feed.

## UX check

Per `team-preferences.md` rule 23 — "Don't Make Me Think" applied to operator CLI:

**Absence-as-state:**
- Target without `deploy:` field: `gazetta deploy production` errors with "no deploy adapter configured"; operator sees the issue immediately, link to docs.
- `target-deploy-coverage` validator emits info-severity (not error) when a target has runtime constraints + no deploy adapter — visible in `gazetta validate`, not noisy at every CLI invocation.

**Universal idioms:**
- `gazetta deploy <target>` — standard verb-object phrasing matching `gazetta publish <target>`.
- Adapter factory names match platform names: `cloudflareWorkersDeploy`, `vercelEdgeDeploy`, `githubPagesDeploy`. No neologisms.

**Same affordance regardless of state:**
- `gazetta deploy production` works the same whether the target was just published or last published a week ago. Operator decides sequencing.
- Adapter's `execute()` surfaces the SAME error class (`DeployContentError`) when published bytes are missing, regardless of which adapter — consistent error UX.

**Plain language:**
- Error messages name the field (`target.deploy`), the adapter (`cloudflare-workers`), and the action (`gazetta publish production` or "switch to a static-capable adapter"). No internal jargon.
- `gazetta validate` deploy issues format identically to other validator output — operators don't learn a new format.

**No help-tooltips-as-bandaid:**
- TypeScript autocomplete + JSDoc on factory parameters carry the discoverability. `r2Storage()` and `cloudflareWorkersDeploy()` documented identically.
- `docs/deploy.md` covers per-adapter setup + the operator's mental model. Single source of truth.

## Migration

Hard cutover per ADR-0005 + ADR-0008 precedent. Pre-1.0 product; operators absorb the rewrite.

**Before:**
```ts
production: {
  storage: r2Storage({ /* ... */ }),
  worker: { type: 'cloudflare', name: 'my-site', bucket: 'my-site' },
  siteUrl: 'https://my-site.com',
}
```

**After:**
```ts
production: {
  type: 'esi',                                   // explicit; was inferred from worker presence
  storage: r2Storage({ /* ... */ }),
  siteUrl: 'https://my-site.com',
  deploy: cloudflareWorkersDeploy({
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    name: 'my-site',
    bucket: 'my-site',
  }),
}
```

Notes:
- `target.worker` field deleted entirely; type-check fails on existing configs at admin boot.
- `worker.name` → `cloudflareWorkersDeploy({ name })`.
- `worker.bucket` → `cloudflareWorkersDeploy({ bucket })`.
- `worker.type: 'cloudflare'` → implicit (the factory function names the platform).
- New: `apiToken` + `accountId` as explicit factory args (were previously sourced inside the hardcoded flow from process.env directly; now operator-supplied via factory call for explicitness).

**Migration scope:**
- Existing fixtures: `examples/starter`, `sites/gazetta.studio`, `tests/fixtures/sites/target-matrix/sites/main/site.config.ts`, test fixtures in `packages/gazetta/tests/fixtures/configs/` — all migrate in Cut 3.
- Doc sweeps: `docs/cloudflare.md`, `.claude/rules/configurations.md`, `.claude/rules/hosting.md`, `.claude/rules/operations.md` — Cut 4.
- External operators: per ADR-0005 precedent, no `gazetta migrate-deploy` CLI. Operators rewrite by hand. CHANGELOG documents the shape.

## Open questions

1. **Adapter discovery via npm-distributed plugins.** The contract supports plugin-distributed adapters (per ADR-0009 — factory function exported from npm package). But how does `gazetta init` scaffolding suggest available adapters? v1 ships in-tree adapters (just Cloudflare Workers); future scaffolding could enumerate npm packages following a `@gazetta/deploy-*` naming convention. Defer until concrete plugin adapter ships.

2. **Rate limiting / queueing concurrent deploys.** If two operators run `gazetta deploy production` simultaneously, what happens? v1: relies on platform-side queueing (Wrangler / Vercel / Netlify all queue). If a platform doesn't queue and concurrent deploys cause issues, add advisory-locking to the adapter contract. Not v1.

3. **`gazetta deploy --dry-run` mode.** Adapter's `validate?` covers static-correctness pre-flight. Dry-run would additionally check platform-side concerns (credentials work; project exists; etc.). Defer until operators ask.

4. **Cancellation semantics in `execute()`.** `DeployContext.signal: AbortSignal` is in the contract. v1 adapters honor it as best-effort — most platform CLIs don't support mid-deploy cancellation. Cleanup behavior post-abort is adapter-specific.

5. **Multiple deploy adapters per target (e.g., deploy worker AND purge CDN AND notify Slack).** Reserved as future composition surface. v1: one adapter per target. If real demand surfaces, a `deployChain([...])` composition pattern (like `auditChain` in `design-provider-config.md`) lands.

## Future directions

- **Container deploy adapters** — permanent shape decision: not on the roadmap. `gazetta serve` + platform CLIs handle this; ADR-0010 locks the boundary.
- **`action: 'deploy'` audit event** — trigger: compliance ask or 3+ operator requests.
- **`beforeDeploy` / `afterDeploy` hooks** — trigger: first concrete consumer with use case CI-step can't handle.
- **`gazetta deploy --dry-run`** — trigger: operator request.
- **Multi-adapter composition (`deployChain([...])`)** — trigger: operator pattern (e.g., deploy + purge CDN + notify Slack) recurs across 3+ operators.
- **Adapter discovery + scaffolding** — trigger: 5+ npm-distributed deploy adapters ship.
- **Per-locale or per-region multi-deploy** — trigger: real demand. Today's per-domain target pattern (per `design-i18n.md`) covers most cases.
