# Gazetta

Stateless CMS that structures websites as composable fragments. All state lives in targets.

## Structure

- `apps/admin/` — CMS admin frontend (Vue 3 + PrimeVue editor shell)
- `packages/gazetta/` — Core package (renderer, CLI, admin API, editor, storage providers)
- `tools/mcp-dev/` — MCP dev server (screenshot tool)
- `bots/` — Autonomous repo bots run on GitHub Actions cron (e.g., flake-watcher); see `bots/README.md`
- `examples/starter/` — Sample site with templates, fragments, pages
- `sites/gazetta.studio/` — The gazetta.studio website (dogfooding)

**Strategic / process docs** (read these before designing or planning):
- `CONTEXT.md` — **Product domain glossary**: canonical vocabulary for the CMS (actors, structural primitives, manifests, references, targets, assets, locale/theme dimensions, composition vs. resolution, project/site/workspace). Covers WHAT we build.
- `.claude/rules/dev-glossary.md` — **Dev-process glossary**: vocabulary for design phases, doc artifacts, testing, bots, skills, triage labels, etc. Covers HOW we work. Auto-loaded.
- `ROADMAP.md` — Strategic forward-looking priorities (Tier 1/2/3 + deferred + non-goals). Updated as priorities shift.
- `docs/non-goals.md` — Explicit strategic non-fits (memberships, content branching, federation, built-in search, visual-first editing, database integration). Read before proposing one of these.
- `docs/audits/cms-feature-audit.md` — Snapshot of Gazetta's coverage vs. the modern CMS landscape, with fact-checked competitor citations. Drives ROADMAP and non-goals.
- `docs/actor-scenarios.md` — Canonical task narratives per actor type (Content Author / Template Developer / Operator / CMS Developer). Yardstick for UX-grilling phase per `feature-design-process.md`.
- `docs/adr/` — Architecture Decision Records for hard-to-reverse, surprising-without-context decisions.

**Public docs** (user-facing):
- `docs/cloudflare.md` — Cloudflare deployment guide (R2, Workers, cache, CI)
- `docs/self-hosted.md` — Self-hosted deployment guide (VPS, Docker, Fly.io)
- `docs/deploy.md` — Deploy adapter contract reference (factory shape, available adapters, container-host pattern)
- `docs/getting-started.md` — Onboarding tutorial
- `docs/template-assets.md` — Template developer guide for asset references
- `docs/content-assets.md` — Content author guide for the asset library
- `docs/migration.md` — Migrating templates from `z.string()` URLs to `embeddedAsset()` references
- `docs/transform-adapters.md` — Per-target image delivery strategies
- `docs/cache.md` — Admin read-side cache configuration + monitoring
- `docs/offline.md` — Offline mode (cold-load reliability, save conflicts, browser support)
- `docs/auth.md` — Authentication + RBAC (trust modes, roles, capability gates)
- `docs/audit.md` — Audit log (forensic event recording, privacy posture, retention, capability gating)
- `docs/hooks.md` — Lifecycle hooks (save / publish / upload extension surface; site-local + npm-distributed factory contributions)
- `docs/soft-delete.md` — Archive / alias / rename / restore / purge for pages and fragments (UX, API, CLI, capability gaps)
- `docs/runtime-capabilities.md` — Per-target capability matrix (`redirects`, `gone-status`); `_redirects` host-glue for plain-static deployments

## Design docs (auto-loaded by Claude)

- `.claude/rules/design-concepts.md` — Fragment, page, node, target model; target properties; active target
- `.claude/rules/design-publishing.md` — Stateless CMS, bidirectional sync, targets, unified Publish
- `.claude/rules/design-decisions.md` — Key decisions and rationale
- `.claude/rules/design-editor-ux.md` — Active target UX spine, switching, progressive disclosure
- `.claude/rules/design-media.md` — Asset model, storage, refs, resolver, delete-with-replace, admin UX, i18n, distinctive choices
- `.claude/rules/design-media-reference.md` — Fact-checked tooling specifics, library versions, licensing, codebase-alignment notes
- `.claude/rules/design-media-implementation.md` — v1 scope + estimates, phased alt, out-of-v1, v1.5/v2 capabilities, frontier opportunities, open questions, migration
- `.claude/rules/design-ai.md` — AI integration: layered architecture, alt-text task, providers (Anthropic/OpenAI/Ollama), refusal handling, prompt composition
- `.claude/rules/design-ai-implementation.md` — v1.5 commit sequence, scope, deferred items, open questions, migration
- `.claude/rules/design-validation.md` — Validation: four-phase model (format/integrity/quality/publish-gate), validator abstraction, severity model, surfaces
- `.claude/rules/design-validation-implementation.md` — Phased cut sequence (save-delta, background scanner, quality validators, publish gate), scope, deferred items
- `.claude/rules/architecture.md` — System architecture and package layout
- `.claude/rules/testing-plan.md` — Active testing coverage + e2e restructure plan (auto-loads when editing tests)
- `.claude/rules/feature-design-process.md` — How feature design + implementation works in Gazetta. The resumability contract (every kind of work has a designated durable artifact). Read when starting feature design or unsure where a piece of work belongs.
- `.claude/rules/dev-glossary.md` — Dev-process vocabulary (design phases, doc artifacts, testing, bots, skills, triage labels). Companion to `CONTEXT.md` (product domain). Auto-loaded.
- `.claude/rules/design-config.md` — Site config reference (companion to ADR-0005). TS config (`gazetta.config.ts` + `site.config.ts`) replacing YAML; identity functions; secrets handling; evaluation timing.
- `.claude/rules/design-logging.md` — Operational logging reference. Structured JSON logs, levels, module namespacing, requestId correlation, privacy rules. Companion to `design-audit.md` (audit = forensic record; logs = operational signal; both run).
- `.claude/rules/design-deploy.md` — `DeployAdapter` Pattern 1 Provider surface. Publish + deploy independence; `target.deploy?` field; `WorkerCapableDeployAdapter` capability for worker-bundling adapters; `storage:` always required + `deploy:` optional; no container adapters (gazetta serve + platform CLIs). Companion to ADR-0010.
- `.claude/rules/design-deploy-implementation.md` — 4-cut sequence (~5-6 days) for v1 contract + Cloudflare refactor. Downstream adapters (#204, #206, #208, #209, #205, #207, #210-212) ship as separate small PRs after.
- `.claude/rules/sidecars.md` — Internal mechanism docs for per-item sidecars (`.{8hex}.hash`, `.pub-{ts}`) and reverse-dep indices (`.gazetta/fragment-deps/`, `.gazetta/asset-refs/`) used for incremental publish + reverse-dep lookups
- `.claude/rules/design-soft-delete.md` — Foundational primitive: archive + alias + rename + restore + purge for pages/fragments. HTML comment marker as the universal mechanism (worker reads first 200 bytes of page HTML); no aggregates. Capability-gap UX surfaced at four points.
- `.claude/rules/design-soft-delete-implementation.md` — 15-cut sequence (~25 days). Manifest fields, alias-aware renderer, archive routes, rename composition, validators, admin UI, conflict prompt UX, resolution UX, CLI, review-workflow integration.
- `.claude/rules/design-redirects.md` — Redirect reference doc (NOT a foundational dimension). Consolidates 301-rename / 410-gone / `_redirects` host-glue / forward-compat invariants. Owner docs: soft-delete (301 + 410); scheduling (future 302/scheduled).
- `.claude/rules/design-scheduling.md` — Foundational primitive: time-based state transitions (single-shot actions + visibility windows). Background scheduler with lock-with-TTL multi-instance coordination; lazy visibility evaluation at render time; capability check at fire time; per-action catch-up policy; 6 validators + 5 audit actions + 4 hook phases.
- `.claude/rules/design-scheduling-implementation.md` — 12-cut sequence + UX research pass (~22 days). Manifest schedule field, atomic conditional-create, sidecar lifecycle, tick loop, capability rehydration, lazy visibility, admin UX (deferred to UX research), operator dashboard, CLI.

## Build & Test

All commands run from the repo root unless noted.

```bash
npm install                              # install all workspace deps
npm run build                            # build all packages
npm run dev                              # examples/starter on localhost:3000
npm test                                 # all workspace tests (~65s for gazetta)
npm test -w packages/gazetta             # one workspace's tests
```

**Single test file / pattern** — run from the package directory:

```bash
cd packages/gazetta && npx vitest run tests/some-file.test.ts
cd packages/gazetta && npx vitest run -t "test name pattern"
```

**Iterating on one file** — use watch mode (per rule 32 Pattern B); each edit reruns in ~10-50ms instead of the ~1.2s cold-start of `vitest run`:

```bash
cd packages/gazetta && npx vitest tests/some-file.test.ts
```

**Type-check** — no repo-level script; per-package:

```bash
cd packages/gazetta && npx tsc --noEmit
```

**Format** — Biome; rule 30 says run before tests, not after (post-test format thrash forces a re-run):

```bash
npm run format                           # write
npm run format:check                     # CI gate
```

**E2e** — Playwright; no wrapping npm script:

```bash
npx playwright test
```

**Mutation** — StrykerJS, opt-in (per `testing-plan.md`); slow:

```bash
npm run test:mutation -w packages/gazetta
```

**Note:** Page and fragment manifests use JSON (`page.json`, `fragment.json`). Site config is TypeScript (`site.config.ts`) using `defineSite()` from the `gazetta` package. Components are inline in the page manifest — no separate component files.

## Conventions

- TypeScript strict mode everywhere
- Prefer composition over inheritance
- Extract shared code only when 3+ callers exist
