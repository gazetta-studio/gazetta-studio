# Roadmap

Forward-looking priorities for Gazetta. What's committed, what's planned, what's parked, what's not happening.

**Updated**: 2026-05-13

## How to read this

- **Now** — committed; in flight or starting in the next 4-8 weeks
- **Next** — planned for the quarter after Now
- **Later** — sequenced behind Now / Next; dependency-ordered
- **Deferred** — real gaps, no current trigger to start
- **Non-goals** — explicit strategic non-fits (see [`docs/non-goals.md`](docs/non-goals.md))

**Capacity assumption**: estimates assume single-maintainer evenings + weekends. "Demand-driven" items have no estimate — the trigger is the estimate.

Priorities derive from [`docs/audits/cms-feature-audit.md`](docs/audits/cms-feature-audit.md). When the audit changes, this roadmap re-derives. Every open issue is bucketed below per the "Issue-classification discipline" in [`feature-design-process.md`](.claude/rules/feature-design-process.md). Shipped status is in the appendix at the bottom; this is a forward-looking document.

## Now (committed, 4-8 weeks)

### Onboarding sprint (3-4 weeks)

Reduce time-to-first-deploy for new operators. Closes the bulk of the deploy-adapters cluster:

- [#203](https://github.com/gazetta-studio/gazetta-studio/issues/203) deploy adapter contract — the foundation; unblocks the rest
- 3 priority adapters proving the contract: [#204](https://github.com/gazetta-studio/gazetta-studio/issues/204) Cloudflare Pages+Functions, [#206](https://github.com/gazetta-studio/gazetta-studio/issues/206) Vercel Edge, [#209](https://github.com/gazetta-studio/gazetta-studio/issues/209) Netlify static
- [#213](https://github.com/gazetta-studio/gazetta-studio/issues/213) container deployment guide
- [#79](https://github.com/gazetta-studio/gazetta-studio/issues/79) Docker example for `gazetta serve`
- [#214](https://github.com/gazetta-studio/gazetta-studio/issues/214) first-run Cloudflare setup

### Manual redirect creation in admin (1 week)

Closes part of [`docs/seo-plan.md`](.claude/rules/seo-plan.md)'s Tier 2 redirect-management punch-list. Soft-delete's HTML markers + per-edge sidecars + `_redirects` host-glue already support redirect-without-archive; needs admin UI affordance for from-route + to-route creation. 301 only (per `design-soft-delete.md` Q14 lock); temporary/scheduled redirects compose with the scheduling primitive.

### Creation UX design pass

[#103](https://github.com/gazetta-studio/gazetta-studio/issues/103) page/fragment/component creation UX — needs Discovery + UX-grilling pass per [`feature-design-process.md`](.claude/rules/feature-design-process.md). Labeled `ready-for-human`; design before implementation.

### Bug backlog

- [#360](https://github.com/gazetta-studio/gazetta-studio/issues/360) `gazetta init` template emits `engines.node = ">=22"` — should match `>=22.22.2` root constraint. `bug + ready-for-agent`; fix-bot territory.

## Next (planned, this quarter)

### Phase 1 — Remaining foundations

| Foundation | Estimate | Status |
|---|---|---|
| `NotificationProvider` (in-admin only) | 1w | ☐ pending |

Other foundations (TS config / AuthIdentity / Component IDs / AdminCache / Audit / Hooks) all ✓ shipped — see appendix.

### Phase 2 — Features composing against foundations

| Feature | Depends on | Estimate |
|---|---|---|
| Per-field translation ([#192](https://github.com/gazetta-studio/gazetta-studio/issues/192)) | i18n design + Component IDs (both shipped) | 2-3w |
| Review workflow MVP ([#199](https://github.com/gazetta-studio/gazetta-studio/issues/199)) | AuthIdentity + Audit + Hooks (all shipped) | 2-3w |
| Comments-first collaboration v1 | AuthIdentity + Audit + Component IDs (shipped) + NotificationProvider (pending) | 3w |

### AI translation task

Per [`design-ai-implementation.md`](.claude/rules/design-ai-implementation.md) deferred items. Second AI task alongside alt-text; validates cross-task `ai/` infrastructure. ~1 week.

### Static publish fan-out

[#202](https://github.com/gazetta-studio/gazetta-studio/issues/202) — real correctness gap. Fragment changes don't trigger fan-out re-renders on static targets. Touches the same dependency-tracking machinery validation Cut 2 uses. 1-2 weeks.

### Small content-feature bundle (1-2 weeks)

- [#58](https://github.com/gazetta-studio/gazetta-studio/issues/58) RSS / Atom feeds
- [#57](https://github.com/gazetta-studio/gazetta-studio/issues/57) pagination for list pages
- [#91](https://github.com/gazetta-studio/gazetta-studio/issues/91) `gazetta validate` checks target connectivity

### Offline mode e2e tests

[#253](https://github.com/gazetta-studio/gazetta-studio/issues/253) — three Playwright specs covering the validation-gate scenarios in `docs/offline.md`. Offline-v1 ships 15 of 16 cuts with 699 unit + integration tests; e2e is the final validation gate. ~1 week.

### MCP server (1-2 weeks)

[#49](https://github.com/gazetta-studio/gazetta-studio/issues/49). Auto-generates MCP tools from existing `admin-api/schemas/` Zod schemas; stdio + HTTP transports; auth via existing API auth. No architectural change required.

### CSP design passes

Two research+design issues filed 2026-05-13. Tier 3 implementation; this quarter for the design work.

- [#361](https://github.com/gazetta-studio/gazetta-studio/issues/361) Content Security Policy: admin surface
- [#362](https://github.com/gazetta-studio/gazetta-studio/issues/362) Content Security Policy: target / published-site surface

## Later (sequenced behind Now / Next)

### Additional deploy adapters (demand-driven)

Post-contract additions to the onboarding sprint:

- [#205](https://github.com/gazetta-studio/gazetta-studio/issues/205) Deno Deploy
- [#207](https://github.com/gazetta-studio/gazetta-studio/issues/207) Netlify Edge Functions
- [#208](https://github.com/gazetta-studio/gazetta-studio/issues/208) GitHub Pages (static-only)
- [#210](https://github.com/gazetta-studio/gazetta-studio/issues/210) Cloudflare Pages (static-only, no Functions)
- [#211](https://github.com/gazetta-studio/gazetta-studio/issues/211) S3 static website
- [#212](https://github.com/gazetta-studio/gazetta-studio/issues/212) Azure Blob static website

### Operability cluster (demand-driven)

Operator-facing features for mature production deployments:

- [#19](https://github.com/gazetta-studio/gazetta-studio/issues/19) configure cache from CMS admin UI
- [#38](https://github.com/gazetta-studio/gazetta-studio/issues/38) cache dynamic route lookups in worker
- [#39](https://github.com/gazetta-studio/gazetta-studio/issues/39) minimal observability for Cloudflare worker
- [#75](https://github.com/gazetta-studio/gazetta-studio/issues/75) parallelize R2 REST API uploads
- [#76](https://github.com/gazetta-studio/gazetta-studio/issues/76) in-memory cache for `gazetta serve`
- [#195](https://github.com/gazetta-studio/gazetta-studio/issues/195) webhooks / post-publish hooks
- [#198](https://github.com/gazetta-studio/gazetta-studio/issues/198) scheduled publishing — composes with scheduling primitive when shipped

### Compare polish (~1 week)

- [#109](https://github.com/gazetta-studio/gazetta-studio/issues/109) compare targets — polish and edge cases
- [#111](https://github.com/gazetta-studio/gazetta-studio/issues/111) standalone compare view

### Tier 3 strategic bets (parallel tracks)

These can run alongside Phase 2 since they don't block foundations:

- SEO metadata editor with SERP preview, OG preview, JSON-LD ([#193](https://github.com/gazetta-studio/gazetta-studio/issues/193))
- RBAC implementation against the shipped design ([#194](https://github.com/gazetta-studio/gazetta-studio/issues/194))
- Audit log implementation against the shipped design ([#200](https://github.com/gazetta-studio/gazetta-studio/issues/200))
- Large-site editor UX ([#196](https://github.com/gazetta-studio/gazetta-studio/issues/196)) — `design-scale.md` shipped; implementation pending
- Environment-specific content ([#62](https://github.com/gazetta-studio/gazetta-studio/issues/62)) — design pass needed first

## Deferred — real gaps, no current trigger

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
| Soft-delete extension to assets | Concrete demand for "rename asset without manual ref cleanup" |
| Per-locale archive (archive only French variant of a page) | Concrete demand for "archive only one locale; default + others stay live" |
| Bulk archive UI in admin | CLI works today (`gazetta archive purge --filter=...`); UI lands when authors ask |
| Page move (parent route reparenting) as distinct concept | Today's rename + alias works through filesystem reparenting; needs design pass |
| Page duplicate / copy as standalone feature | Authors can copy directories today; UI affordance when concrete demand surfaces |
| Find-and-replace across content (string match) | Operator asks; orthogonal to existing dependents-walking |
| Versioned aliases (`@header-v1` + `@header-v2` simultaneously) | Strategic-bet level; would require revising `design-soft-delete.md` Q3 — needs its own design pass |
| Branch / PR-style workflows | Strategic bet; depends on concurrent-editing positioning |
| Snapshot-named revisions ("v1.5 release snapshot") | Concrete demand from operators wanting recoverable named checkpoints |
| Bulk import from other CMSes (Notion, WordPress, Sanity) | Concrete operator request; manifest format is import-friendly |
| Hidden but live (visible at URL, not in nav/sitemap) | Concrete demand; composes with publish flow + sitemap generation |
| Time-windowed visibility (live between dates) | Composes with scheduling primitive when shipped |
| Lock / immutability (lock published version) | Compliance archetype; archive transitions imply this — explicit lock when distinct intent surfaces |
| Editorial calendar / planning view | Operator asks |
| Search index CLI | Operator asks; integrate Algolia/Meilisearch |
| Synced blocks (inline content reuse) | Inline-reuse demand materializes; Fragments cover ~80% today |
| Visual editing mode (parallel to form-driven) | Marketing-team operator asks specifically |
| Bidirectional relations beyond Usages | Wiki-style use case surfaces |
| OG image preview + JSON-LD helpers | Part of [#193](https://github.com/gazetta-studio/gazetta-studio/issues/193) when picked up |
| Admin `theme.ts` JS preset bridge ([#135](https://github.com/gazetta-studio/gazetta-studio/issues/135)) | Per `css-theming.md`: product matures past prototype phase |
| Google Cloud Storage provider ([#8](https://github.com/gazetta-studio/gazetta-studio/issues/8)) | Operator asks |
| Pass dynamic route params at request time ([#80](https://github.com/gazetta-studio/gazetta-studio/issues/80)) | Composes with `design-rendering.md` request-SSR work when shipped |
| Publish from static target ([#92](https://github.com/gazetta-studio/gazetta-studio/issues/92)) | Static targets don't store source manifests; real "publish from static" workflow surfaces |

## Non-goals

See [`docs/non-goals.md`](docs/non-goals.md) for full rationale. Summary:

- Memberships / subscriptions / paywalls / native newsletters → Ghost territory
- Content branching (git-like content branches) → multi-Target covers it
- Content federation at CMS level → templates handle external data
- Built-in full-text site-wide search → delegate to Algolia / Meilisearch
- Visual editing as primary editor paradigm → form-first by design
- Database integration → stateless CMS is a defining property
- E-commerce primitives → out of scope
- Solid.js / Svelte template support — niche; existing template contract already supports any framework
- Broad plugin system beyond documented extension surfaces — see [ADR-0009](docs/adr/0009-no-plugin-runtime-factory-contributions.md)

## Process

When a Now item ships, the next item from Next promotes (or is deliberately re-prioritized). When a design pass completes, the corresponding implementation moves from Later to Next.

Every issue is classified into a bucket above at file time per [`feature-design-process.md`](.claude/rules/feature-design-process.md) "Issue-classification discipline." Unclassified issues are a process bug.

Tier transitions are tracked here. Ship-status of individual cuts lives in `design-{feature}-implementation.md` files.

---

# Appendix: Shipped status

Historical record. Forward planning is above this line.

## Foundational design passes — all complete 2026-05

Cross-cutting dimensions every feature design must respect (see [`feature-design-process.md`](.claude/rules/feature-design-process.md) "Foundational dimensions"). Each landed a `design-{name}.md` and adds a check to every new feature design.

1. **[`design-scale.md`](.claude/rules/design-scale.md)** — operating envelope (5K pages / 20K assets / 50 components-per-page); tree virtualization; paginated `/api/pages`; search-driven navigation; lazy-load asset library. Implementation pending: [#88](https://github.com/gazetta-studio/gazetta-studio/issues/88) (nested route tree + search), [#196](https://github.com/gazetta-studio/gazetta-studio/issues/196).
2. **[`design-i18n.md`](.claude/rules/design-i18n.md)** — migrated from `i18n-plan.md`. Locale as closed dimension peer to theme; locale-priority cross-dimension fallback; whole-file overlay model; subpath / per-domain / hybrid routing strategies; hreflang via HTML or sitemap. 13 of 15 implementation steps shipped; per-field translation tracked in [#192](https://github.com/gazetta-studio/gazetta-studio/issues/192).
3. **[`design-themes.md`](.claude/rules/design-themes.md)** — presentation theming (light/dark, color schemes, accessibility variants) as a render-context dimension. Pages/fragments stay theme-agnostic at the data layer; theme reaches templates via `params.theme` peer to `params.locale`.
4. **[`design-auth-rbac.md`](.claude/rules/design-auth-rbac.md)** — covers [#194](https://github.com/gazetta-studio/gazetta-studio/issues/194). Trust modes (configurable v1, plugin reserved); hybrid built-in + custom roles; capability-based authorization gates.
5. **[`design-audit.md`](.claude/rules/design-audit.md)** — covers [#200](https://github.com/gazetta-studio/gazetta-studio/issues/200). `AuditProvider` extension surface #11; v1 ships `HistoryAuditProvider`; v2 external sinks expected order: HTTP webhook → file → OTel → CloudWatch → Azure Monitor → syslog.
6. **[`design-review-workflow.md`](.claude/rules/design-review-workflow.md)** — covers [#199](https://github.com/gazetta-studio/gazetta-studio/issues/199). Per-content review state machine + per-target publish approval; 5 archetype recipes; capability extensions; single reject with mandatory comment.
7. **[`design-rendering.md`](.claude/rules/design-rendering.md)** — three target types (`static` / `esi` / `dynamic`); three fragment rendering types; worker boundary discipline; content-addressed worker cache.
8. **[`design-hooks.md`](.claude/rules/design-hooks.md)** — save / publish / load / upload / review lifecycle phases; return-new-payload contract; priority-based composition.
9. **[`design-config.md`](.claude/rules/design-config.md)** — TS config replaces YAML; `defineGazetta` / `defineSite` identity functions; `process.env.X` for secrets; per [ADR-0005](docs/adr/0005-typescript-config-format.md).
10. **[`design-plugins.md`](.claude/rules/design-plugins.md)** — TS-import discovery; factory exports returning contributions; per [ADR-0009](docs/adr/0009-no-plugin-runtime-factory-contributions.md) there is no `Plugin` runtime contract.
11. **[`design-cache.md`](.claude/rules/design-cache.md)** — L4 cache; ships `MemoryCache` (per-instance v1; 10K entries / 50MB LRU); deterministic-derived principle; SSE broadcast for cross-instance coordination.
12. **[`design-offline.md`](.claude/rules/design-offline.md)** — always-on UX; pending edits vs save queue distinction; IndexedDB primary + MemoryCache fallback; service worker for app-shell; conflict surfaces diff with no force-overwrite.
13. **[`design-collaboration.md`](.claude/rules/design-collaboration.md)** — comments-first v1; mentions; in-admin notifications via `NotificationProvider` Extension Surface #12.
14. **[`design-soft-delete.md`](.claude/rules/design-soft-delete.md)** — **implementation also shipped 2026-05** — all 15 cuts merged on `soft-delete-v1`. Archive + alias + rename + restore + purge for pages/fragments. HTML comment marker as the universal mechanism; capability-gap UX surfaced at four points.
15. **[`design-scheduling.md`](.claude/rules/design-scheduling.md)** — single-shot actions + time-windowed visibility. Background scheduler with lock-with-TTL multi-instance coordination; lazy visibility evaluation at render time. Implementation pending in [#198](https://github.com/gazetta-studio/gazetta-studio/issues/198) (12 cuts + UX research pass, ~22 days).

## Phase 0 — Implementation planning artifacts (complete 2026-05)

All 19 `design-{feature}-implementation.md` docs shipped: ai, audit, auth-rbac, cache, collaboration, config, hooks, i18n, media, offline, plugins, provider-config, rendering, review-workflow, scale, scheduling, soft-delete, themes, validation.

## Phase 1 — Foundations (largely shipped 2026-05)

| Foundation | Status |
|---|---|
| TS config migration | ✓ shipped |
| AuthIdentity layer | ✓ shipped (6 trust-mode providers; 9 test files; 66 admin-API integrations) |
| Component IDs | ✓ shipped (`component-ids.ts`; called from page + fragment save handlers) |
| AdminCache abstraction | ✓ shipped (interface + `MemoryCache` + per-site + 6 test files) |
| Audit primitive (v1 scope) | ✓ shipped (recorder + middleware + `HistoryAuditProvider`) |
| Hooks lifecycle | ✓ shipped (factory contributions via `admin.hooks` per ADR-0009; 10 test files) |
| NotificationProvider (in-admin) | ☐ pending — see Next |

**Plugin loader retired** per [ADR-0009](docs/adr/0009-no-plugin-runtime-factory-contributions.md). The locked plugin design pre-2026-05 was collapsed: Path X ([ADR-0008](docs/adr/0008-provider-factory-returns-instance.md)) covers Provider surfaces; Hooks Cut 9 ships factory contributions; Validators / Routes follow the contribution-array pattern.

## Phase 2 — Features composing against foundations

- ✓ Validation Cut 2 (background scanner) — scanner manages its own memoization
- ✓ Validation Cut 3 (render-for-analysis + a11y)
- ✓ Offline mode v1 — AdminCache + Vue Query + `idb` + `vite-plugin-pwa` + 5-state connection machine + conflict UI + 9 test files

Remaining (see Next): per-field translation, review workflow MVP, comments-first collaboration v1.

## Validation Cuts 1-6 — shipped

Closes [#40](https://github.com/gazetta-studio/gazetta-studio/issues/40).

- Cut 1: save-time integrity (`Validator` interface, save-delta orchestrator, 5 ref-existence validators, 409 wiring, `ValidationBanner.vue`)
- Cut 2: background scanner + `SiteHealthDrawer.vue` + 3 background-only validators (`schema-conformance`, `orphaned-locale-file`, `unused-fragment`)
- Cut 3: render-for-analysis + a11y (axe-core) + html-validity + `altRequired`
- Cut 4: pre-publish audit step in `PublishPanel.vue` + `publish-audit.ts` + linkinator (`validators/broken-links.ts`)
- Cut 5: `gazetta validate` CLI rewrite (15 tests)
- Cut 6: template-developer surfaces (`template-impact.ts`)
- Plus 5 soft-delete-related validators beyond the original scope

**Lighthouse validator** (originally Cut 4) **deferred indefinitely** — see `design-validation-implementation.md` deferred-items table.

## Editor papercut cluster — largely shipped

- ✓ [#104](https://github.com/gazetta-studio/gazetta-studio/issues/104) metadata editing UX — via soft-delete; rename composes archive + create + alias
- ✓ [#105](https://github.com/gazetta-studio/gazetta-studio/issues/105) component ordering UX — drag-and-drop (`@formkit/drag-and-drop` in `ComponentTree.vue`); closed 2026-05-08
- ✓ [#82](https://github.com/gazetta-studio/gazetta-studio/issues/82) breadcrumb navigation — closed 2026-05-09
- ✓ [#45](https://github.com/gazetta-studio/gazetta-studio/issues/45) component duplication — closed 2026-05-08
- ☐ [#103](https://github.com/gazetta-studio/gazetta-studio/issues/103) creation UX — see Now

## Hygiene

- ✓ Dependabot [#219](https://github.com/gazetta-studio/gazetta-studio/issues/219)
- ✓ `@hono/node-server` v2 bump (PR #224)
- ✓ Component reordering immediate-save ([#106](https://github.com/gazetta-studio/gazetta-studio/issues/106), PR #225)

## Other shipped

- ✓ [#88](https://github.com/gazetta-studio/gazetta-studio/issues/88) nested route tree + search/filter (closed 2026-05-04)
- ✓ [#184](https://github.com/gazetta-studio/gazetta-studio/issues/184) reload target registry on `site.config.ts` change (closed 2026-05-12)
- ✓ [#61](https://github.com/gazetta-studio/gazetta-studio/issues/61) 301 redirects via soft-delete (closed 2026-05-12)
- ✓ [#201](https://github.com/gazetta-studio/gazetta-studio/issues/201) image transformations (closed 2026-05-12)
- ✓ [#56](https://github.com/gazetta-studio/gazetta-studio/issues/56) pages export fragments for cross-page linking (closed 2026-05-12)
