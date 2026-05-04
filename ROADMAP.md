# Roadmap

Strategic forward-looking priorities for Gazetta. Captures what's prioritized, what's deferred, and what's a non-goal.

**Updated**: 2026-05-04

## How to read this

- **Tier 1** = next 4-8 weeks; explicit commitment
- **Tier 2** = next quarter; planned but not started — includes **foundational design passes** (architectural dimensions every feature must respect) alongside committed implementation work
- **Tier 3** = strategic bets; implementation work that depends on a foundational design pass being done first
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

7. **`design-config.md`** (complete 2026-05) — reference doc, NOT a foundational dimension. TS config (`gazetta.config.ts` + `site.config.ts`) replaces `site.yaml`; `defineGazetta` / `defineSite` identity functions; global + per-site split with defaults flow; `process.env.X` for secrets; load-once-at-boot in production, hot-reload in dev; plugin authors export factory functions invoked inline. Decision in [`docs/adr/0005-typescript-config-format.md`](docs/adr/0005-typescript-config-format.md). Implementation Tier 3 — ships migration tool (`gazetta migrate-config`) + sweeps every YAML example across ~30 design docs to TS in a single PR; hard cutover removes YAML support.

8. **`design-plugins.md`** (1-2 weeks) — unifying plugin contract: discovery, loading, lifecycle, composition. Depends on `design-config.md` (plugins invoked inline in `defineSite()` via factory functions). Existing 10 extension surfaces (storage, templates, editors, fields, transforms, deploy adapters, AI providers, hooks, validators, cache providers) follow the contract.

9. **`design-cache.md`** (1 week) — pluggable caching layer with multiple provider implementations. Ships `MemoryCache` (per-instance, v1 default) + reserved providers for v2 (Redis, Azure storage, file-based, distributed). Same extension-surface pattern as storage providers. Multi-instance discipline: per-instance providers are correct via independence; shared providers via the provider's own coordination.

10. **`design-offline.md`** (1-2 weeks) — admin works through transient connectivity loss. Read paths serve from a browser-side persistent cache (extends cache taxonomy with `IndexedDBCache` + `LocalStorageCache`); write paths queue + replay on reconnect; conflict resolution on stale write. Pending edits persist across browser reload. Composes with cache (extends taxonomy), RBAC (role-aware cache scope), audit log (replay events recorded), real-time event-source (cache invalidation broadcasts).

11. **`design-collaboration.md`** (2-3 weeks) — comments (page-level + inline + asset + review-event), mentions, notifications (in-admin + pluggable Notification Provider as Extension Surface candidate), activity feed, presence (cursor sharing reserved). Composes with auth/RBAC (capability vocabulary extends), audit log (collaboration events recorded), review workflow (approver leaves comment without gating approval), hooks (`afterCommentPosted`, `afterMention`). Discovered while grilling review-workflow Q1 — "approve-with-caveats" is a conversation, not a state-machine state.

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
- #184 reload target registry on `site.yaml` change — unblocks the deferred hotfix-from-prod e2e scenario per `testing-plan.md`

### Image transformations (media v1.5 followon)
- #201 image transformations (resize, crop, WebP/AVIF, focal point)

### Environment-specific content
- #62 environment-specific content — design pass needed; sized after design

## Tier 3 — strategic bets (implementation pending foundational design)

### Themes implementation (4-6 weeks)
After `design-themes.md` lands. Theme variants for pages/fragments + runtime theme routing + admin theme switcher per active page.

### Auth + RBAC + audit + review implementation (6-10 weeks)
After `design-auth-rbac.md`, `design-audit.md`, `design-review-workflow.md` all land. The team CMS feature set: roles, authorization gates on every API endpoint, audit log records on every write, per-content review state machine, per-target publish approval.

### Per-field translation (#192)
After `design-i18n.md` lands. Layered overlay model on top of existing whole-file locale variants.

### Real-time presence
After `design-audit.md` lands (audit log is the event source). Sanity Presence as reference. Real-time transport implementation lands as part of presence (1-2 weeks); presence MVP (presence-only, no concurrent editing): 4 weeks.

### Hooks implementation
After `design-hooks.md` lands. Phased cut sequence similar to validation's 6-cut pattern.

### Plugin implementation
After `design-plugins.md` lands. Unifies existing extension surfaces under one contract.

### Validation Cut 4 (publish gate + heavy validators)
Per [`design-validation-implementation.md`](.claude/rules/design-validation-implementation.md). Adds Lighthouse via Playwright + linkinator. Operator-controlled strictness at publish time. **Effort**: 5 days.

### Validation Cut 5 + 6 (CLI rewrite + template-developer surfaces)
Per design-validation-implementation. Closes out the validation system.

### Concurrent editing with OT/CRDT
Huge investment. After presence-only ships and product positioning is clear. 3-6 months.

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
