# Roadmap

Strategic forward-looking priorities for Gazetta. Captures what's prioritized, what's deferred, and what's a non-goal.

**Updated**: 2026-05-04

## How to read this

- **Tier 1** = next 4-8 weeks; explicit commitment
- **Tier 2** = next quarter; planned but not started — historically included foundational design passes alongside committed implementation work; design corpus is now complete
- **Tier 3** = phased implementation plan against the complete design corpus; ~7-11 month horizon for Phase 0 + Phase 1 + Phase 2 + Phase 3
- **Deferred** = real gaps but not the right time
- **Non-goals** = explicit strategic non-fits — see [`docs/non-goals.md`](docs/non-goals.md)

Priorities derive from [`docs/audits/cms-feature-audit.md`](docs/audits/cms-feature-audit.md). When the audit changes, this roadmap re-derives.

## Strategic commitments

The framing decisions that shape multi-quarter priorities. Resolved (no longer "open questions"):

- **Gazetta is a team CMS** — not a solo developer tool. RBAC + audit log + review workflows are foundational dimensions, not Tier 3 strategic bets. Implementation defers; design lands as a Tier 2 design pass.
- **Plugins are foundational** — the existing extension surfaces (storage, templates, editors, fields, transforms, deploy adapters, AI providers, hooks, validators, cache providers) ARE the plugin system. The unifying contract (discovery, lifecycle, composition) gets a Tier 2 design pass; broader runtime extensibility (custom routes, custom CLI) waits for concrete demand.

## Tier 1 — committed (next 4-8 weeks)

### Hygiene (done)
- ✓ Land dependabot PR #219 — shipped
- ✓ Land `@hono/node-server` v2 bump (PR #224) — shipped
- ✓ Fix bug #106 (component reordering immediate-save, PR #225) — shipped

### Validation Cut 1 (4 days)
Save-time integrity validation per [`design-validation.md`](.claude/rules/design-validation.md). Establishes the `Validator` interface; ships 5 reference-existence validators; closes part of issue #40.

### Editor papercut cluster (2-3 weeks)
Aggregate small-but-high-impact UX wins:
- #103 page/fragment/component creation UX
- #104 metadata editing UX (template, name, route)
- #105 component ordering UX (drag-and-drop research)
- #82 breadcrumb navigation in edit mode
- #45 component duplication

### Onboarding sprint (3-4 weeks)
Closes part of the deploy-adapters cluster:
- #203 deploy adapter contract (the foundation; unblocks the rest)
- 3 priority adapters proving the contract: #204 Cloudflare Pages+Functions, #206 Vercel Edge, #209 Netlify static
- #213 container deployment guide
- #79 Docker example for `gazetta serve`
- #214 first-run Cloudflare setup (operator UX)

## Tier 2 — planned (next quarter)

### Foundational design passes

Thirteen cross-cutting dimensions that every feature design must respect (see [`feature-design-process.md`](.claude/rules/feature-design-process.md) "Foundational dimensions"). Each is a separate design pass that lands a `design-{name}.md` and adds a check to every new feature design. Implementation phases sit in Tier 3 unless otherwise noted.

Sequence (per dependency order):

1. **`design-scale.md`** (1-2 weeks) — covers #88 (nested route tree + search), #196 (large-site editor profile). Establishes operating envelope (target N pages / M assets / K components). Strategy for tree virtualization, paginated `/api/pages`, search-driven navigation, lazy-load asset library. Gates every UI/API design that follows.

2. **`design-i18n.md`** (complete 2026-05) — migrated from `i18n-plan.md`. Locked: locale as closed dimension peer to theme; locale-priority cross-dimension fallback; whole-file overlay model; subpath/per-domain/hybrid routing strategies; hreflang via HTML or sitemap. 13 of 15 implementation steps shipped; remaining steps (admin "Translate to..." action + `gazetta validate` locale checks) tracked under editor papercut cluster + validation Cut 5 respectively.

3. **`design-themes.md`** (complete 2026-05) — presentation theming (light/dark, color schemes, accessibility variants) as a render-context dimension. Pages/fragments stay theme-agnostic at the data layer; theme reaches templates via `params.theme` peer to `params.locale`. Asset-level theme variants already shipped per `design-media.md`. Other variant motivations (audience, campaign, A/B, multi-tenant) are explicitly NOT bundled into themes — each gets its own design pass when concrete demand surfaces.

4. **`design-auth-rbac.md`** (complete 2026-05) — covers #194 (RBAC). Trust modes (configurable v1, plugin reserved); hybrid built-in + custom roles, single role per principal, group-claim mapped; capability-based authorization gates with role aliases. Implementation Tier 3.

   - **`design-audit.md`** (complete 2026-05) — covers #200 (audit log). `AuditProvider` extension surface #11; v1 ships `HistoryAuditProvider` with `outcome` field on every event, structured `actor` snapshot, sync fail-open + parallel fan-out, separable retention, opt-in pseudonymization (sha256 + salt), trust-mode-driven sourceIp extraction; v2 expected order: `HttpWebhookAuditProvider` first, then file → OTel → CloudWatch → Azure Monitor → syslog. Implementation Tier 3.

   - **`design-review-workflow.md`** (complete 2026-05) — covers #199 (review workflows). Per-content review state machine (`draft / pending-review / approved`) + per-target publish approval (opt-in via `requiresPublishApproval`); 5 archetype recipes (solo / small-content / small-release / mid / compliance); capability extensions (`review:submit`, `review:approve`, `publish:request`, `publish:approve`); single reject with mandatory comment; `requiredApprovers` snapshotted at submit; `allowSelfApproval` defaults true; `invalidateOnSave` defaults `'content-diff'`. Pages + fragments reviewable in v1; assets defer to v2. Implementation Tier 3.

5. **`design-rendering.md`** (complete 2026-05) — full rendering taxonomy. Three target types (`static` / `esi` / `dynamic`); three fragment rendering types (static / dynamic / island); worker boundary discipline (workers never run templates); content-addressed worker cache; `RenderContext` for dynamic fragments; per-fragment timeout + failure modes (`empty` / `placeholder` / `fail-page`); programmatic page-query API for listings; three route modes (static / static-with-params / dynamic); deployment matrix per platform. Provisional locks on dynamic-side details (worker→origin protocol, page composition with mixed-rendering fragments) flagged for follow-up grilling. Sub-task: #80 dynamic route params at request time. Implementation Tier 3.

6. **`design-hooks.md`** (complete 2026-05) — extension surface for save/publish/load lifecycles. Phases: `beforeSave`/`afterSave`/`afterLoad`/`beforePublish`/`afterPublish`/`beforeUpload`/`afterUpload` + 10 review-lifecycle phases. Return-new-payload contract; sync-blocking with per-hook timeout (5s default). Priority-based composition (3 bands: built-in 0-99 / plugin 100-999 / site-local 1000+); `before*` chains, `after*` parallel, fail-open. Discovery: site-local files in `admin/hooks/` + plugin-supplied via plugin contract. Render hooks deferred. Validation hooks rejected (validators are pure). Audit `action: 'hook-fired'` + `outcome: 'hook-cancelled'` closed-enum extensions. Implementation Tier 3.

7. **`design-config.md`** (complete 2026-05) — reference doc, NOT a foundational dimension. TS config (`gazetta.config.ts` + `site.config.ts`) replaces `site.yaml`; `defineGazetta` / `defineSite` identity functions; global + per-site split with defaults flow; `process.env.X` for secrets; load-once-at-boot in production, hot-reload in dev; plugin authors export factory functions invoked inline. Decision in [`docs/adr/0005-typescript-config-format.md`](docs/adr/0005-typescript-config-format.md). Implementation shipped 2026-05 (Phase 1 first foundation): hard cutover replaces YAML with TS in one branch (`config-ts-migration`, 13 commits); ~30 design docs swept; `js-yaml` dep removed; `gazetta init` scaffolds TS config; no automated migration tool (operators rewrite by hand per ADR-0005).

8. **`design-plugins.md`** (complete 2026-05) — unifying plugin contract: TS-import discovery (no auto-discovery; `import slackNotify from '@gazetta/slack-notify'` in `defineSite()`); serial async init with fail-boot default + `optional()` opt-in for graceful skip; factory function exports returning `Plugin`; per-surface `PluginAPI` methods (typed registration, IDE autocomplete); `registerRoute` for plugin-contributed admin routes with Zod schemas + capability gates; reserved capability prefixes for built-ins (`read:` / `edit:` / `delete:` / `publish:` / `configure:` / `review:` / `restore:`); peerDep on `gazetta` + load-time warn-not-refuse SemVer check; full Node access (no sandbox) with `serviceAccount` opt-in for elevated plugin hooks. Implementation Tier 3.

9. **`design-cache.md`** (complete 2026-05) — L4 cache (admin/origin server tier) in the layered cache model. Ships `MemoryCache` (per-instance v1; 10K entries / 50MB cap, LRU); reserved v2 providers (Redis, Azure, File, Distributed). Deterministic-derived value principle (cache values must be derivable from inputs encoded in key); explicit per-feature invalidation with sidecar-driven cascades; SSE broadcast for cross-instance coordination; PWA-style responsiveness (best-effort `invalidatePrefix` with ~100ms cap; never block save responses); fail-open transport errors with auto-reconnect on subscribe disconnect; colon-separated keys with concatenated compound dimensions (target/locale/theme/principal); 255-char cap with overflow-hash; per-site cache instances; JSON-serializable values for L4↔L6 offline composition; `CacheError` taxonomy (config-time vs schema-time vs transport-fail-open); plugin-contributed providers via `api.registerCacheProvider()`; `adminCacheContractTests` helper. Implementation Tier 3.

10. **`design-offline.md`** (complete 2026-05) — UX-first design. **Always-on** (no opt-out config; offline UX is structural, not configurable). Pending edits and save queue are distinct concepts: pending edits per-item persist across navigation/reload/offline; save queue replays save attempts on reconnect. Author navigates freely between pages with unsaved pending edits; never forced to save. IndexedDB primary persistence with MemoryCache fallback (localStorage rejected — sync API + tight quota); npm stack: `idb` + `@tanstack/vue-query` + `@tanstack/query-async-storage-persister` + native `BroadcastChannel`. Service worker for app-shell precache (via `vite-plugin-pwa`); Background Sync + PWA install + push notifications reserved for v2. Hybrid connection detection (`navigator.onLine` + on-demand heartbeat); 5-state model. Conflict resolution surfaces diff with Show/Discard actions (no force-overwrite — author manually re-edits to layer changes onto current state); chained `If-Match` projections for multi-write replay. Replayed events audit with `metadata.replayed: true` + `queuedAt` + `replayedAt`. Bundle cost ~80-100KB. Implementation Tier 3.

11. **`design-collaboration.md`** (complete 2026-05) — comments-first v1: page-level + inline (anchored by stable component IDs) + asset + review-event comments; mentions via `@`-picker (structured references, not text-parsed); in-admin notifications via `NotificationProvider` Extension Surface #12 (`InAdminNotificationProvider` v1; Email/Slack/Webhook/Teams/Discord v2 expected order). 5 new RBAC capabilities (`read:comments` / `comment:write` / `comment:moderate` / `mention:any` / `subscribe:any`). 6 new hook phases. Per-thread sidecars under `.gazetta/comments/` (per-edge granularity); etag-based concurrency for thread updates; client-generated thread IDs (offline-friendly). Plain text + structured mentions (no Markdown, no attachments in v1). Activity feed / presence / reactions / per-user preferences UI / approval-blocking deferred to v2. Krug-aligned UX (absence-as-state per [team-preferences rule 23](.claude/rules/team-preferences.md)). Implementation Tier 3.

12. **`design-logging.md`** (complete 2026-05) — reference doc, NOT a foundational dimension. Operational logging conventions: structured JSON logs (no `console.log` in production); 5 levels (`trace` / `debug` / `info` / `warn` / `error`); dot-separated module namespacing (`cache.memory`, `plugin.@gazetta/slack-notify`); `requestId` for cross-instance correlation; PII exclusion (auth tokens / manifest content / comment bodies / asset bytes — all forbidden); `pino` recommended; logs to stdout (operator wires aggregator). Logging vs audit: audit is forensic record; logs are operational signal; both run. Added as "Logging discipline" to `feature-design-process.md`'s Non-foundational disciplines.

### Validation Cut 2 + 3 (8 days)
- Cut 2: background scanner + admin UI surfaces (tree dots, "Site health" drawer) — closes #40 fully
- Cut 3: render-for-analysis + a11y (axe-core) + html-validate + `altRequired`

### Static publish fan-out (1-2 weeks)
Issue #202 — real correctness gap. Fragment changes don't trigger fan-out re-renders on static targets. Touches the same dependency-tracking machinery validation Cut 2 needs.

### Small content-feature bundle (1-2 weeks)
- #61 redirects (301/302)
- #58 RSS / Atom feeds
- #57 pagination for list pages
- #91 `gazetta validate` checks target connectivity

### AI translation task (1 week)
Per [`design-ai-implementation.md`](.claude/rules/design-ai-implementation.md) deferred items. Adds translation as the second AI task next to alt-text; validates the cross-task `ai/` infrastructure.

### More deploy adapters (~2 weeks; demand-driven)
Post-contract additions to the onboarding sprint:
- #205 Deno Deploy
- #207 Netlify Edge Functions
- #208 GitHub Pages (static-only)
- #210 Cloudflare Pages (static-only, no Functions)
- #211 S3 static website
- #212 Azure Blob static website

### MCP server as alternative admin (1-2 weeks)
Issue #49. Auto-generates MCP tools from the existing `admin-api/schemas/` Zod schemas; ships an MCP transport (stdio + HTTP); auth via existing API auth. Schema-discipline note in `feature-design-process.md` ensures every new admin-API route stays MCP-compatible. No architectural change required.

### Operability cluster (~2 weeks; demand-driven)
Operator-facing features that mature production deployments:
- #19 configure cache from CMS admin UI
- #38 cache dynamic route lookups in worker
- #39 minimal observability for Cloudflare worker
- #75 parallelize R2 REST API uploads
- #76 in-memory cache for `gazetta serve`
- #195 webhooks / post-publish hooks
- #198 scheduled publishing

### Compare polish (1 week)
- #109 compare targets — polish and edge cases
- #111 standalone compare view

### E2e infrastructure
- #184 reload target registry on `site.config.ts` change — unblocks the deferred hotfix-from-prod e2e scenario per `testing-plan.md`

### Image transformations (media v1.5 followon)
- #201 image transformations (resize, crop, WebP/AVIF, focal point)

### Environment-specific content
- #62 environment-specific content — design pass needed; sized after design

## Tier 3 — implementation phases (design corpus complete; building features)

The 13-dimension foundational design corpus is complete. Implementation is now sequenced as four phases. **No backwards-compatibility constraint** (pre-1.0 product); cutovers are clean. **No external shipping pressure**; architectural correctness prioritized over velocity.

Total horizon: ~7-11 months for Phase 0 + Phase 1 + Phase 2 + Phase 3. Tier 3 strategic bets (concurrent editing, etc.) deferred indefinitely.

### Phase 0 — Implementation planning artifacts (1-2 weeks)

Write 7 missing `design-{feature}-implementation.md` docs:
- `design-auth-rbac-implementation.md`
- `design-audit-implementation.md`
- `design-hooks-implementation.md`
- `design-plugins-implementation.md`
- `design-cache-implementation.md`
- `design-offline-implementation.md`
- `design-collaboration-implementation.md`

Each defines cut sequence, per-cut scope, files added/modified, tests, integration consumer for validation, and SOLID checks. No migration sections needed (no backwards compat).

Plus: lock the cross-cutting sequencing (TS config affects every consumer; serial), per-foundation test plans, and integration test strategy across foundations.

### Phase 1 — Foundations (8-12 weeks)

Each foundation: code + unit tests + contract tests (where it's an extension surface) + integration tests + at least one consumer integration + user-facing docs. Sequenced to respect cross-cutting dependencies.

| Foundation | Sequence | Estimate |
|---|---|---|
| ✓ TS config migration | First (mechanical, affects everything) — shipped 2026-05 | 1-2w |
| AuthIdentity layer | After TS config (Principal extraction; trust modes) | 2w |
| Component IDs | Independent (structural manifest change) | 1w |
| AdminCache abstraction | Independent (replaces existing memos) | 1-2w |
| Audit primitive | After AuthIdentity (records `actor` snapshot) | 1-2w |
| Hooks lifecycle | After AuthIdentity (`Principal` in HookContext) | 2w |
| Plugin loader | After TS config + Hooks (factory invocation; PluginAPI) | 1-2w |
| NotificationProvider (in-admin only) | After Hooks (in-admin via subscribe) | 1w |

### Phase 2 — Features composing against foundations (10-14 weeks)

| Feature | Depends on | Estimate |
|---|---|---|
| Validation Cut 2 (background scanner) | AdminCache | 4 days |
| Validation Cut 3 (render-for-analysis + a11y) | AdminCache + Cut 2 | 5 days |
| Per-field translation (#192) | i18n design (shipped) + Component IDs | 2-3w |
| Review workflow MVP | AuthIdentity + Audit + Hooks | 2-3w |
| Comments-first collaboration v1 | AuthIdentity + Audit + Component IDs + NotificationProvider | 3w |
| Offline mode v1 | AdminCache + service worker stack (idb + Vue Query + vite-plugin-pwa) | 3w |

### Phase 3 — Polish, parallel tracks, remaining cuts (8-12 weeks)

These can run in parallel with Phase 1-2 since they don't depend on the foundations:

- **Editor papercut cluster** (2-3w; Tier 1 commitment): #103, #104, #105, #82, #45
- **Onboarding sprint** (3-4w; Tier 1 commitment): #203 deploy adapter contract + 3 priority adapters + #213 container guide + #79 Docker example + #214 first-run UX

After foundations + features land:

- **Validation Cut 4-6** (~3w): publish gate + Lighthouse, CLI rewrite, template-developer surfaces
- **Static publish fan-out** (#202, 1-2w)
- **Small content cluster** (1-2w): #61 redirects, #58 RSS/Atom, #57 pagination, #91 connectivity validate
- **Operability cluster** (2w): #19, #38, #39, #75, #76, #195, #198
- **MCP server** (#49, 1-2w)
- **Documentation thorough sweep** (3w; spread across phases)
- **Examples + gazetta.studio updates** (2w)
- **Compare polish** (1w): #109, #111
- **E2e infra** (#184, small)
- **Image transformations** (#201, sized after design)
- **Environment-specific content** (#62, design pass first)

### Deferred indefinitely (demand-driven)

| Item | Trigger to revisit |
|---|---|
| Real-time presence MVP | Operator demand for live collaboration awareness |
| Concurrent editing with OT/CRDT (3-6 months investment) | Presence ships first + product positioning clear |
| AI tag suggestion task | After translation ships |
| AI image generation | Concrete operator request |
| Per-locale comments | Concrete demand |
| Approval-blocking comments | Compliance archetype demand |
| File attachments on comments | Operator asks |
| Markdown formatting in comments | Operator asks |
| Activity feed | Operator asks |
| Reactions on comments | Operator asks |
| Email/Slack/Teams/Discord NotificationProviders | Operator demand (expected order locked in `design-collaboration.md` Q3) |
| Edge SSR for `dynamic` Targets (WinterTC origin) | WASM-compiled templates or framework support catches up |

### Constraints driving this scope

- **No backwards compatibility**: cutovers replace existing code wholesale; no migration tooling required
- **No shipping pressure**: architectural correctness prioritized; foundations shipped before features
- **Maintainer attention is finite**: deferred items respect their triggers; don't pre-build for hypothetical demand
- **Design corpus is cohesive**: cutting features creates incomplete consumer profiles that make foundations look over-designed; we ship the full feature set the design corpus assumes

## Deferred — real gaps but not now

| Item | Why deferred | Trigger to revisit |
|---|---|---|
| AI tag suggestion task | Lower priority than translation | After translation ships |
| AI image generation | Strategic bet; needs design | Concrete operator request |
| Editorial calendar / planning view | Quick win but no urgent demand | Operator asks |
| Search index CLI | Bounded but no urgent demand | Operator asks; integrate Algolia/Meilisearch |
| Synced blocks (inline content reuse) | Fragments cover most cases | Inline-reuse demand materializes |
| Visual editing mode (parallel to form-driven) | Strategic non-fit absent clear demand | Marketing-team operator asks specifically |
| Bidirectional relations beyond Usages | Notion-specialty, not industry-standard | Wiki-style use case surfaces |
| OG image preview + JSON-LD helpers | SERP preview shipped | Issue #193 |
| `gazetta eject-worker` (#46) | Power-user feature; demand-driven | Operator asks |
| Pages export fragments for cross-page linking (#56) | Niche; current model covers most cases | Concrete cross-page-export use case |
| Publish from static target (#92) | Static targets don't store source manifests; would need a separate source-resolution path | Real "publish from static" workflow surfaces |
| Admin theme.ts JS preset bridge (#135) | Per `css-theming.md`: deferred until product maturity warrants the added surface area | Product matures past prototype phase |
| Google Cloud Storage provider (#8) | Additive; no concrete operator demand | Operator asks |
| Worker eject (#46) | Additive | Operator asks |

## Non-goals (strategic non-fits)

See [`docs/non-goals.md`](docs/non-goals.md) for full rationale. Summary:

- Memberships / subscriptions / paywalls / native newsletters → Ghost territory
- Content branching (git-like content branches) → multi-Target covers it
- Content federation at CMS level → templates handle external data
- Built-in full-text site-wide search → delegate to Algolia / Meilisearch (filtered listings + permission-filtered output ARE in scope, covered by `design-rendering.md` + `design-auth-rbac.md`)
- Visual editing as primary editor paradigm → form-first by design
- Database integration → stateless CMS is a defining property
- E-commerce primitives → out of scope
- Solid.js / Svelte template support (#65, #69) — niche; React/Vue/Svelte template authoring already works via the template's own framework choice
- Broad plugin system beyond documented extension surfaces — the named surfaces (storage, templates, editors, fields, transforms, deploy adapters, AI providers, hooks, validators, cache providers) ARE the plugin system; broader runtime extensibility (custom routes, custom CLI) waits for concrete demand

## Process

When a Tier 1 item ships, the next item from Tier 2 promotes (or is deliberately re-prioritized). When a Tier 2 design pass completes, the corresponding Tier 3 implementation can start.

Every issue is classified into a roadmap bucket at file time per `feature-design-process.md` "Issue-classification discipline." Unclassified issues are a process bug.

Tier transitions are tracked here. Ship-status of individual cuts/items lives in their respective `design-{feature}-implementation.md` files.
