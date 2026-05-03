# CMS Feature Audit

Snapshot of how Gazetta's feature surface compares to the modern CMS landscape (Sanity, Contentful, Storyblok, Strapi 5, Payload 3, Directus, Hygraph, WordPress + Gutenberg, Webflow, Framer, Notion, DatoCMS, Builder.io, Decap, TinaCMS, Kirby, Statamic, Craft, Ghost, Hugo / Astro / 11ty).

**Date**: 2026-05-03
**Posture**: Honest assessment of where Gazetta has, hasn't, and shouldn't have certain features.

This audit informs [ROADMAP.md](../../ROADMAP.md) and [non-goals.md](../non-goals.md). When new categories are identified or existing claims are refuted, update this audit and re-derive priorities.

## Why this exists

Without periodic external benchmarking, a CMS drifts toward what its maintainers find interesting rather than what users need. This audit forces an explicit "what's missing" check against the broader market. The audit itself is durable; the conclusions (priorities) live in ROADMAP.

---

## Feature coverage matrix

Legend: ✅ shipped · ⚠ partial · ❌ missing · ⛔ explicit non-goal

### Content modeling

| Feature | Status | Notes |
|---|---|---|
| Page / document types | ✅ | Pages, Fragments, Inline Components |
| Reusable components | ✅ | Fragments + Inline Components |
| Content schemas (Zod) | ✅ | Per-template schema |
| Content references / relations | ✅ | Asset References, Fragment References, Usages |
| Rich text editor | ⚠ | @rjsf with field widgets; no canonical rich-text |
| Tables | ❌ | Custom field could solve |
| Repeatable / array fields | ✅ | Zod arrays via @rjsf |
| Conditional fields (show X if Y=1) | ❌ | @rjsf supports it; not exposed |
| Reusable content blocks (cross-doc) | ✅ | Fragments cover this |
| Content versioning per field | ❌ | History is per-Manifest, not per-field |
| Custom field types | ✅ | `meta({ field: 'name' })` |

### Media management

| Feature | Status | Notes |
|---|---|---|
| Upload | ✅ | |
| Library with grid/table | ✅ | |
| Search & filter | ✅ | |
| Folders | ❌ | Tags only (per design) |
| Tags | ✅ | |
| Image variants (srcset) | ✅ | Responsive Variants |
| Focal point | ✅ | |
| Alt text (manual + AI) | ✅ | |
| Locale variants | ✅ | |
| Theme variants | ✅ | |
| Image transforms (CDN-style) | ⚠ | sharp + cloudflare adapters; no on-demand resize URL |
| Video upload + thumbnail | ⚠ | Uploads work; thumbnail extraction deferred |
| Audio (duration, waveform) | ⚠ | Duration ✅; waveform ❌ |
| Documents (PDF, etc.) | ✅ | |
| Fonts | ✅ | |
| Asset versioning ("sync all usage") | ❌ | Replace-and-delete; no versioning |
| Custom metadata fields ("aspects") | ❌ | Tags only |
| Crop rectangle (not just focal) | ❌ | |
| LQIP / blurhash placeholders | ❌ | |
| AI alt-text | ✅ | v1.5: Anthropic / OpenAI / Ollama |
| External URL / paste-URL upload | ❌ | |

### Authoring workflow

| Feature | Status | Notes |
|---|---|---|
| WYSIWYG-ish preview | ✅ | Live preview iframe |
| Form-driven editing | ✅ | @rjsf |
| Custom editors (per template) | ✅ | |
| Auto-save | ❌ | Explicit save (per `team-preferences.md`) |
| Drafts (separate from published) | ⚠ | Implicit: local Target IS the draft |
| Per-field draft / publish | ❌ | |
| Comments / annotations on content | ❌ | |
| Mentions (@user) | ❌ | |
| Activity feed | ❌ | |
| Notifications (email/Slack on publish) | ❌ | Per `operations.md`: deferred |
| Side-by-side compare | ⚠ | Compare is logical, not visual |
| Content branching | ⛔ | See non-goals: multi-target covers it |
| Concurrent editing safety | ❌ | "Last write wins" |

### Publishing & distribution

| Feature | Status | Notes |
|---|---|---|
| Multi-target publish | ✅ | Core feature |
| Bidirectional sync | ✅ | Source / Destination roles |
| Static rendering | ✅ | |
| Dynamic SSR | ✅ | |
| Edge runtime (Workers) | ✅ | |
| Self-hosted Node/Bun | ✅ | |
| Per-page partial publish | ✅ | |
| Scheduled publishing | ❌ | Issue #198 |
| Republish all | ✅ | |
| Cache purge | ✅ | Cloudflare; others deferred |
| Webhooks / post-publish hooks | ❌ | Issue #195 |
| Deploy adapters (Vercel/Netlify/etc.) | ❌ | Issues #203-212 |
| Static fan-out on fragment change | ❌ | Issue #202 — correctness gap |

### i18n / localization

| Feature | Status | Notes |
|---|---|---|
| Locale-suffix manifests | ✅ | Locale Variant pattern |
| Subpath routing | ✅ | |
| Per-domain routing | ✅ | |
| Locale fallback chain | ✅ | |
| hreflang generation | ✅ | |
| Sitemap with i18n | ✅ | |
| Language detection / redirect | ⚠ | Designed; not implemented |
| Per-field translation | ❌ | Whole-file Locale Variants only |
| Translation management UI (TMS) | ❌ | "Translate" action is one-step copy |
| Translation memory | ❌ | |
| AI translation | ❌ | Designed for v1.6 in `design-ai-implementation.md` |
| RTL support | ⚠ | css-theming + RTL audit done for asset workflow |

### SEO

| Feature | Status | Notes |
|---|---|---|
| Title / description / canonical | ✅ | With fallback chains |
| OG image | ✅ | |
| Twitter card | ✅ | |
| Robots meta | ✅ | |
| Sitemap.xml | ✅ | |
| Robots.txt | ✅ | |
| JSON-LD / structured data | ❌ | Templates can emit; no helper |
| SERP preview | ✅ | |
| OG image preview | ❌ | |
| Redirects (301/302) | ❌ | Issue #61 |
| RSS / Atom feeds | ❌ | Issue #58 |
| `llms.txt` | ❌ | Per `seo-plan.md`: too early |
| Pagination for list pages | ❌ | Issue #57 |

### Validation & quality

| Feature | Status | Notes |
|---|---|---|
| Field-level validation (Zod) | ✅ | Form layer |
| Save-time integrity validation | ❌ | Validation Cut 1 designed |
| Background quality scanner | ❌ | Validation Cut 2 designed |
| Accessibility audit (a11y) | ❌ | Validation Cut 3 designed |
| HTML validity | ❌ | Cut 3 |
| CSS lint | ❌ | Cut 3 |
| Broken link checking | ❌ | Cut 4 |
| Lighthouse / perf scoring | ❌ | Cut 4 |
| `gazetta validate` CLI | ⚠ | Exists; rewrite designed (Cut 5) |
| Pre-publish gate | ❌ | Cut 4 |

### Permissions / collaboration / governance

| Feature | Status | Notes |
|---|---|---|
| Authentication | ⚠ Basic auth only | Per `operations.md` |
| RBAC / roles | ❌ | Issue #194 |
| User management | ❌ | |
| Audit log | ❌ | Issue #200 |
| Review workflows / approvals | ❌ | Issue #199 |
| SSO / SAML / OIDC | ❌ | |
| Per-content permissions | ❌ | |
| API tokens | ❌ | |
| 2FA / MFA | ❌ | |

### Developer experience

| Feature | Status | Notes |
|---|---|---|
| Local dev server | ✅ | `gazetta dev` |
| Hot reload | ✅ | |
| TypeScript types | ✅ | |
| CLI | ✅ | |
| Schema-driven types in templates | ✅ | |
| Custom editors | ✅ | |
| Custom fields | ✅ | |
| Storybook-like playground | ⚠ | `/admin/dev` playground |
| API client generation | ❌ | Manual fetch |
| OpenAPI / GraphQL | ❌ | Plain REST/JSON via Hono |
| Migration tools (schema → content) | ❌ | |
| Seed data / fixtures | ⚠ | Test fixtures in monorepo only |
| Plugin system | ❌ | Adapters yes (transform, AI); plugins no |
| Hooks / extension surface | ❌ | Strategic gap; not yet designed |

### Operations

| Feature | Status | Notes |
|---|---|---|
| Logs | ⚠ stdout only | |
| Metrics / observability | ❌ | Issue #39 |
| Health checks | ❌ | |
| Backup / disaster recovery | ✅ Implicit | History + git |
| Rate limiting | ❌ | |
| Request tracing | ❌ | |
| Alerts | ❌ | |
| Multi-region | ⚠ | Possible via per-target setup |

### Content delivery / advanced rendering

| Feature | Status | Notes |
|---|---|---|
| Preview environments per branch | ❌ | |
| A/B testing / experiments | ❌ | |
| Personalization | ❌ | |
| Dynamic route params at render | ⚠ | Issue #80 |
| Edge data (KV / D1 / etc.) | ❌ | |
| ISR / on-demand revalidation | ⚠ | Cache purge yes |
| Image-on-demand (`/_image?...`) | ❌ | sharp adapter is pre-generated |

### Themes / templates

| Feature | Status | Notes |
|---|---|---|
| Templates (per project) | ✅ | |
| Multi-framework templates | ✅ | React/Vue/Svelte |
| Template marketplace | ❌ | |
| **Theme as a packaged/installable concept** | ❌ | **No first-class Theme primitive — strategic gap** |
| Theme switching at runtime (dark/light) | ⚠ | Theme override dimension on assets exists; runtime SSR theme branching deferred |
| User-pluggable theme tokens | ⚠ | Documented in `css-theming.md`; no formal contract for site authors |
| Pre-built starter themes | ❌ | Just `examples/starter` |
| Block library (drag-and-drop) | ❌ | |
| Visual editor (no-code page builder) | ⛔ | See non-goals: form-first by design |

### Data / external integrations

| Feature | Status | Notes |
|---|---|---|
| External data fetching at render | ✅ | Templates can fetch |
| Database integration | ⛔ | Stateless CMS — explicit non-goal |
| Form handling / submissions | ❌ | |
| Search | ⛔ | See non-goals: integrate, don't build |
| Newsletter signup | ⛔ | See non-goals: Ghost territory |
| E-commerce primitives | ⛔ | Out of scope |

### Migration / interoperability

| Feature | Status | Notes |
|---|---|---|
| Import from other CMS | ❌ | |
| Export to portable format | ⚠ | Storage IS portable |
| Backup / restore | ⚠ | History + git |
| Schema migrations | ❌ | |
| `gazetta validate --fix` | ❌ | |

---

## Genuinely missed categories — not covered by the matrix above

Modern CMSes provide several primitives that don't fit neatly into traditional categories. These are gaps where Gazetta has *nothing* (vs. partial coverage):

### 1. Real-time collaborative presence
**What it is**: Live "X is editing this paragraph" indicators (caret positions per editor).
**Reference**: [Sanity Presence](https://www.sanity.io/blog/introducing-presence) ✓ verified.
**Why it matters**: Required for team-CMS positioning. Solo authors don't need it; teams of 3+ do.
**Architectural impact**: Substantial — adds real-time channel + cross-replica state coordination.

### 2. Hooks / extension surface
**What it is**: Lifecycle hooks — beforeChange, afterChange, beforeValidate, etc.
**Reference**: [Payload Hooks](https://payloadcms.com/docs/hooks/overview) ✓ verified (3 hooks confirmed in official docs; broader set claimed by community).
**Why it matters**: Template Developer pain point. Auto-slugify, auto-tag, validate against external API. Today: nothing.
**Architectural impact**: Minimal — register hooks in admin-API save/publish paths.

### 3. AI content ops broader than alt-text
**What it is**: AI generation, translation, summarization, tag suggestion, image generation embedded across the content lifecycle.
**Reference**: [Contentful AI Actions](https://www.contentful.com/blog/) ✓ verified — AI Actions documented at multiple lifecycle stages.
**Why it matters**: 2026 expectation. Gazetta has alt-text only.
**Architectural impact**: Zero — `ai/` directory was specifically designed for cross-task reuse. Each task is a new adapter directory.

### 4. Themes as a first-class primitive
**What it is**: Packaged themes (templates + admin customizations + default content + Site Manifest scaffolding) that an Operator installs.
**Reference**: WordPress, Webflow have theme stores; most headless CMSes don't.
**Why it matters**: Adoption multiplier. Operators with no Template Developer can adopt Gazetta.
**Architectural impact**: Medium — npm package convention + scaffold mechanism in `gazetta init` + theme upgrade path.

### 5. Editorial calendar / planning view
**What it is**: Visual calendar showing scheduled content, by author, with editorial status.
**Reference**: Sanity, Contentful, Strapi.
**Why it matters**: Teams plan content ahead. Solo blogger doesn't need it.
**Architectural impact**: Zero infrastructure — different view of existing data.

### 6. Bidirectional relations / auto-backlinks
**What it is**: "X mentions Y" auto-creates "Y is mentioned in [list]" — Notion-style database relations with auto-inverse.
**Reference**: Notion (verified). Webflow's "backlinks" are external links, not CMS reference tracking (✗ corrected from earlier claim).
**Why it matters**: Wikis, knowledge bases. Gazetta has Usages already for assets/fragments — generalizing to arbitrary relations is the gap.
**Architectural impact**: Small if constrained to existing kinds; large if generalized.

### 7. Synced blocks (inline content reuse)
**What it is**: Content snippet (paragraph, callout) that exists in one canonical place and mirrors elsewhere.
**Reference**: [Notion Synced Blocks](https://www.notion.com/help/synced-blocks), [GitBook Synced Blocks](https://docs.gitbook.com/content-editor/blocks/synced-blocks-beta) — both verified.
**Why it matters**: Niche. Fragments cover ~80% of the use case. Inline reuse is Notion-style file-system-fluid CMS territory.
**Architectural impact**: Small — could be a new component kind.
**Priority**: LOW — Fragments cover most cases; revisit if demand materializes.

### 8. Real-time WebSocket subscriptions
**What it is**: Push CMS state changes to admin clients via WebSocket.
**Reference**: [Directus Realtime](https://directus.io/docs/configuration/realtime) ✓ verified.
**Why it matters**: Live preview without polling, dashboards.
**Architectural impact**: Medium — Hono supports WebSocket on Node/Bun but not on Workers (uses Durable Objects for stateful connections). Per-target runtime constraint.

### 9. Memberships / monetization / paywalls / newsletters
**What it is**: Audience management, subscription tiers, native email sending, content access gating.
**Reference**: [Ghost Memberships + native newsletters](https://ghost.org/) ✓ verified.
**Status**: ⛔ Strategic non-goal — see [non-goals.md](../non-goals.md).

### 10. Content branching (git-like content branches)
**What it is**: Delta-based siblings of a Source Target with merge semantics.
**Reference**: [Contentstack Branches](https://www.contentstack.com/docs/developers/branches/about-branches) ⚠ verified but **scope overstated** — merge applies to content types and global fields, NOT entries/assets.
**Status**: ⛔ Strategic non-goal — multi-Target covers ~80-90% of use cases.

---

## Strategic non-fits (architectural mismatch)

Documented in [non-goals.md](../non-goals.md):

- **Memberships / monetization** — Ghost / Substack territory
- **Content branching** — multi-Target covers it
- **Content federation at CMS level** — templates handle external data fetching
- **Built-in full-text search** — delegate to Algolia / Meilisearch
- **Visual editing as primary paradigm** — form-first by design

Each has documented rationale in non-goals.md; this audit just notes them.

---

## Fact-check ledger

This audit's claims were fact-checked on 2026-05-03. Notable corrections from the initial pass:

| Claim | Status | Correction |
|---|---|---|
| Sanity Presence shows live caret positions | ✓ | Verified via [docs](https://www.sanity.io/docs/content-lake/realtime-updates) |
| Sanity introduced Asset Versions in 2026 | ⚠ | Feature exists but timing wrong — pre-2026 |
| Contentful has "contentful-merge" | ✗ | No such feature in official docs — initial claim invented |
| Contentstack Branches cover entries + assets + content models | ⚠ | Overstated — merge is content types and global fields ONLY, not entries/assets |
| Strapi defers unique validation until publish | ⚠ | Opposite of reality — known bug ([issue #15636](https://github.com/strapi/strapi/issues/15636)), not a designed feature |
| Webflow has automatic backlink display | ✗ | "Backlinks" in Webflow refers to external website links, not CMS reference tracking |
| "68% of content teams struggle with approval bottlenecks" | ⚠ | Real stat in third-party citations; original SEMrush source not directly accessible |
| Payload has 7 hooks (incl. beforeRead, afterRead, etc.) | ⚠ | Only 3 confirmed in official docs (beforeValidate, beforeChange, afterChange) |

**Lesson**: don't cite competitor features without verifying against official docs. Captured in [team-preferences.md](../../.claude/rules/team-preferences.md).

---

## How to update this audit

When competitive landscape shifts (a CMS ships a notable feature), or when Gazetta closes a gap:

1. Update the matrix entry (✅ ⚠ ❌ ⛔)
2. If the change crosses the strategic-significance bar, also update [ROADMAP.md](../../ROADMAP.md)
3. If a strategic non-fit becomes worth revisiting, move from [non-goals.md](../non-goals.md) back to ROADMAP

Audit refresh cadence: every quarter, or whenever a major competitor ships a notable primitive.
