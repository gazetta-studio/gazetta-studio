# Roadmap

Strategic forward-looking priorities for Gazetta. Captures what's prioritized, what's deferred, and what's a non-goal.

**Updated**: 2026-05-04

## How to read this

- **Tier 1** = next 4-8 weeks; explicit commitment
- **Tier 2** = next quarter; planned but not started
- **Tier 3** = strategic bets; design pass needed before scoping
- **Deferred** = real gaps but not the right time
- **Non-goals** = explicit strategic non-fits — see [`docs/non-goals.md`](docs/non-goals.md)

Priorities derive from [`docs/audits/cms-feature-audit.md`](docs/audits/cms-feature-audit.md). When the audit changes, this roadmap re-derives.

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
Closes the deploy-adapters cluster — 12+ blocked issues:
- #203 deploy adapter contract (the foundation; unblocks the rest)
- 2-3 priority adapters (likely #204 Cloudflare Pages+Functions, #206 Vercel Edge, #209 Netlify static)
- #213 container deployment guide
- #79 Docker example for `gazetta serve`

## Tier 2 — planned (next quarter)

### Validation Cut 2 + 3 (8 days)
- Cut 2: background scanner + admin UI surfaces (tree dots, "Site health" drawer)
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

### Hooks / extension surface (2 weeks design + 1-2 weeks implementation)
Audit category #2. Template Developer pain point — auto-slugify, auto-tag, validate against external API, enrich content at save time. Reference: [Payload Hooks](https://payloadcms.com/docs/hooks/overview).

Design pass first; scope cut similar to validation's 6-cut sequence.

## Tier 3 — strategic bets (design pass needed before scoping)

### Themes as a first-class primitive
Audit category #4. Adoption multiplier. Big design space:
- Are themes versioned independently? Probably yes.
- Can a Theme override admin chrome or only template-side rendering? Probably template-side only.
- Theme switching for existing content — compatibility layer needed?
- Marketplace mechanics — npm? Curated registry?

**Design effort**: 2 weeks. **Implementation**: 4-6 weeks. Real bet.

### RBAC + audit log + review workflows (joint design)
Issues #194 + #200 + #199. Combined effort: ~6-10 weeks.
Without these, Gazetta is a solo-dev tool. With these, it serves teams.

**Design effort**: 1-2 weeks (joint design across the three). **Implementation**: 6-10 weeks.

### Real-time presence (read-only)
Audit category #1. Sanity Presence as reference. Hardest to retrofit later — adds an architectural primitive (real-time channel) that affects every team feature.

**Design effort**: 1 week. **Implementation MVP** (presence-only, no concurrent editing): 4 weeks. Full collab editing (OT/CRDT): 3-6 months.

### Validation Cut 4 (publish gate + heavy validators)
Per [`design-validation-implementation.md`](.claude/rules/design-validation-implementation.md). Adds Lighthouse via Playwright + linkinator. Operator-controlled strictness at publish time.

**Effort**: 5 days.

### Validation Cut 5 + 6 (CLI rewrite + template-developer surfaces)
Per design-validation-implementation. Closes out the validation system.

## Deferred — real gaps but not now

| Item | Why deferred | Trigger to revisit |
|---|---|---|
| AI tag suggestion task | Lower priority than translation | After translation ships |
| AI image generation | Strategic bet; needs design | Concrete operator request |
| Editorial calendar / planning view | Quick win but no urgent demand | Operator asks |
| Search index CLI | Bounded but no urgent demand | Operator asks; integrate Algolia/Meilisearch |
| Synced blocks (inline content reuse) | Fragments cover most cases | Inline-reuse demand materializes |
| Visual editing mode (parallel to form-driven) | Strategic non-fit absent clear demand | Marketing-team operator asks specifically |
| Real-time WebSocket subscriptions | Polling + SSE works | Live multi-user features land |
| Concurrent editing with OT/CRDT | Huge investment | After presence-only ships and product positioning is clear |
| Bidirectional relations beyond Usages | Notion-specialty, not industry-standard | Wiki-style use case surfaces |
| Per-field translation | Whole-file Locale Variants work | Issue #192 — design pass when team-i18n use case lands |
| OG image preview + JSON-LD helpers | SERP preview shipped | Issue #193 |
| Solid.js / Svelte template support | Niche; React/Vue/Svelte already covers most | Template Developer asks |
| Dynamic route params at request time (#80) | Premature — no request-time SSR consumer yet (pages and fragments are pre-rendered today; ESI mode composes pre-rendered HTML, doesn't run templates per request) | Request-time dynamic SSR design starts; params plumbing lands as a sub-task of that |

## Non-goals (strategic non-fits)

See [`docs/non-goals.md`](docs/non-goals.md) for full rationale. Summary:

- Memberships / subscriptions / paywalls / native newsletters → Ghost territory
- Content branching (git-like content branches) → multi-Target covers it
- Content federation at CMS level → templates handle external data
- Built-in full-text search → delegate to Algolia / Meilisearch
- Visual editing as primary editor paradigm → form-first by design
- Database integration → stateless CMS is a defining property
- E-commerce primitives → out of scope

## Process

When a Tier 1 item ships, the next item from Tier 2 promotes (or is deliberately re-prioritized). When a strategic Tier 3 design pass completes, it transitions to a sized Tier 2 build.

Tier transitions are tracked here. Ship-status of individual cuts/items lives in their respective `design-{feature}-implementation.md` files.

## Open strategic questions (no commitment yet)

These are framing decisions that shape multiple roadmap items but haven't been resolved:

1. **Team CMS or developer-team file-based CMS?** First answer pulls in real-time presence + RBAC + concurrent editing (Sanity competitor). Second answer says hooks + themes + AI content ops are enough (Decap / TinaCMS competitor). The decision shapes 2-3 quarters of priorities.

2. **MCP server as alternative admin** (issue #49)? Strategic — would Gazetta be controllable via an LLM agent, opening "AI authors content directly" workflows. No commitment yet.

3. **Plugin system for site authors** (beyond adapters)? Custom field widgets exist; broader plugins (custom routes, custom storage providers, etc.) would be another extension surface. Lower priority than hooks.
