# Gazetta

Stateless CMS that structures websites as composable fragments. All state lives in targets.

## Structure

- `apps/admin/` — CMS admin frontend (Vue 3 + PrimeVue editor shell)
- `packages/gazetta/` — Core package (renderer, CLI, admin API, editor, storage providers)
- `tools/mcp-dev/` — MCP dev server (screenshot tool)
- `examples/starter/` — Sample site with templates, fragments, pages
- `sites/gazetta.studio/` — The gazetta.studio website (dogfooding)

**Strategic / process docs** (read these before designing or planning):
- `CONTEXT.md` — **Domain glossary**: canonical vocabulary for the CMS (actors, structural primitives, manifests, references, targets, assets, locale/theme dimensions, composition vs. resolution, project/site/workspace). Use the glossary terms in conversations, code, and docs.
- `ROADMAP.md` — Strategic forward-looking priorities (Tier 1/2/3 + deferred + non-goals). Updated as priorities shift.
- `docs/non-goals.md` — Explicit strategic non-fits (memberships, content branching, federation, built-in search, visual-first editing, database integration). Read before proposing one of these.
- `docs/audits/cms-feature-audit.md` — Snapshot of Gazetta's coverage vs. the modern CMS landscape, with fact-checked competitor citations. Drives ROADMAP and non-goals.
- `docs/adr/` — Architecture Decision Records for hard-to-reverse, surprising-without-context decisions.

**Public docs** (user-facing):
- `docs/cloudflare.md` — Cloudflare deployment guide (R2, Workers, cache, CI)
- `docs/self-hosted.md` — Self-hosted deployment guide (VPS, Docker, Fly.io)
- `docs/getting-started.md` — Onboarding tutorial
- `docs/template-assets.md` — Template developer guide for asset references
- `docs/content-assets.md` — Content author guide for the asset library
- `docs/migration.md` — Migrating templates from `z.string()` URLs to `embeddedAsset()` references
- `docs/transform-adapters.md` — Per-target image delivery strategies
- `docs/cache.md` — Admin read-side cache configuration + monitoring
- `docs/offline.md` — Offline mode (cold-load reliability, save conflicts, browser support)

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
- `.claude/rules/design-config.md` — Site config reference (companion to ADR-0005). TS config (`gazetta.config.ts` + `site.config.ts`) replacing YAML; identity functions; secrets handling; evaluation timing.
- `.claude/rules/design-logging.md` — Operational logging reference. Structured JSON logs, levels, module namespacing, requestId correlation, privacy rules. Companion to `design-audit.md` (audit = forensic record; logs = operational signal; both run).
- `.claude/rules/sidecars.md` — Internal mechanism docs for per-item sidecars (`.{8hex}.hash`, `.pub-{ts}`) and reverse-dep indices (`.gazetta/fragment-deps/`, `.gazetta/asset-refs/`) used for incremental publish + reverse-dep lookups

## Build & Test

```bash
npm install        # install dependencies (from root)
npm run build      # build all packages
npm run dev        # start dev server (examples/starter on localhost:3000)
npm test           # run all tests
```

**Note:** Page and fragment manifests use JSON (`page.json`, `fragment.json`). Site config is TypeScript (`site.config.ts`) using `defineSite()` from the `gazetta` package. Components are inline in the page manifest — no separate component files.

## Conventions

- TypeScript strict mode everywhere
- Prefer composition over inheritance
- Extract shared code only when 3+ callers exist
