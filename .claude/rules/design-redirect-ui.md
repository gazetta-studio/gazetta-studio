# Redirect UI

How operators create Manual Redirects via the admin UI. Companion to [`design-redirects.md`](design-redirects.md) — that doc is the reference for the redirect mechanism (HTML markers, `_redirects` host-glue, 301-only-in-v1). This doc covers the specific feature of operator-driven redirect creation without a preceding rename.

**Status**: design pass complete (2026-05-14). Implementation: see [`design-redirect-ui-implementation.md`](design-redirect-ui-implementation.md).

**Companion docs:**
- [`design-redirects.md`](design-redirects.md) — consolidated redirect reference (the mechanism)
- [`design-soft-delete.md`](design-soft-delete.md) — owner of archive primitives + capability-gap UX
- [`feature-design-process.md`](feature-design-process.md) — defines design-doc + implementation-doc artifact pattern
- [`../../CONTEXT.md`](../../CONTEXT.md) — domain glossary: Archive, Alias, Redirect, Pure Soft-Delete entries
- Tracked in [#364](https://github.com/gazetta-studio/gazetta-studio/issues/364)

## Scope

**In v1:**
- Manual Redirect creation via admin UI for both pages and fragments
- New `POST /api/redirects` endpoint with `{ from, to, kind: 'page' | 'fragment' }` body
- New `CreateRedirectDialog.vue` peer to `CreatePageDialog.vue` / `CreateFragmentDialog.vue`
- New "+ New redirect" button in `SiteTree.vue`'s create-affordance row
- New `action: 'create-redirect'` audit enum value
- Schema refinement: `template` becomes conditionally optional when `archived: true`
- Conflict handling for live-name and archived-name source collisions
- Capability gate: `edit:pages` / `edit:fragments` (NOT delete-class — adds state, doesn't destroy)
- Cross-target propagation via existing publish flow (no auto-publish)

**Out of v1 (deferred):**
- Dedicated `/admin/redirects` list page (existing tree "Show archived" filter handles "find existing redirects" today)
- Bulk CSV import (WordPress Redirection plugin moat; demand-driven)
- 404-log-to-redirect path (Gazetta has no 404 log yet)
- Wildcard / regex from-routes
- Conditional redirects (login state, browser, referrer)
- 302 / scheduled / time-bounded redirects (reserved for scheduling primitive composition per `design-redirects.md` "Future surfaces")

**Non-goals (strategic non-fits):**
- A/B test redirects per cohort — `design-redirects.md` line 120 documents as Out
- URL Rewrite (different mechanism; Gazetta does not own URL rewriting)

## Locked decisions (the eight Qs)

Per the grilling session 2026-05-14 against the design corpus + discovery-prep-bot's research. Decisions below are the load-bearing choices; each was grilled with rejected alternatives.

### Q1 — Redirect is a first-class domain noun

Promoted to [`CONTEXT.md`](../../CONTEXT.md) as a domain noun (Approach 3 narrow shape). Definition: "A Page or Fragment whose manifest carries `archived: true` AND a non-empty `aliasOf` pointing at a live target." Two origin sub-categories: **Rename Redirect** (composed during rename) and **Manual Redirect** (created standalone via this feature). Both produce the same on-disk shape; the distinction matters for forensic queries and UX entry points.

CONTEXT.md cluster added: **Archive** (verb + state), **Alias** (data field), **Redirect** (this entry), **Pure Soft-Delete** (archived without aliasOf — emits 410 Gone).

**Rejected alternatives:**
- **A1 stay implicit** ("Create archive with alias") — operator-hostile; forces translation through soft-delete internals. Krug-test: requires help tooltip to explain what "archive" means in this context.
- **A2 UI-affordance noun only** (UI says "Redirect" but no CONTEXT.md entry) — code/docs/UI asymmetry without reason; breeds tribal knowledge.

**Why C wins**: dimensional model (status code, scheduling, lifecycle) belongs in `design-redirects.md`; CONTEXT.md owns "what is this thing?" — Approach 3 captures the origin axis (rename vs manual) + defers permanence/scheduling to the reference doc. Future revisit trigger: scheduling primitive ships → CONTEXT entry doesn't need to change because dimensions live in `design-redirects.md`.

### Q2 — `POST /api/redirects` new endpoint

Clean noun in the URL. Route file `packages/gazetta/src/admin-api/routes/redirects.ts` peer to `archive.ts`. One write, atomic, one history revision, one audit event.

```
POST /api/redirects
Content-Type: application/json
{ "from": "old-name", "to": "new-name", "kind": "page" }   // or "fragment"

Response 201:
{ "ok": true, "from": "old-name", "to": "new-name", "kind": "page",
  "route": "/old-name", "targetRoute": "/new-name" }

Errors:
- 400 INVALID                         — bad name characters; empty fields
- 409 LIVE_NAME_CONFLICT              — `from` is a live page (Q4)
- 409 ARCHIVED_NAME_CONFLICT          — `from` is already an archive (Q4; reuses soft-delete Q5 prompt)
- 409 ALIAS_TARGET_NOT_FOUND          — `to` doesn't exist as live page/fragment
- 403 FORBIDDEN                       — missing capability (Q8)
```

**A1 sub-decision: schema refinement, not sentinel.** Make `PageManifest.template` and `FragmentManifest.template` conditionally optional via Zod `.refine` when `archived: true`. Cleaner than writing a sentinel `'__redirect__'` template value that no renderer ever executes. Reflects the runtime reality (renderer already short-circuits archived items via `if (isArchived(page)) return publishArchiveMarker(...)`).

**Rejected alternatives:**
- **B: Extend `CreatePageRequestSchema` with optional `archived`/`aliasOf`** — schema lies; SRP violation. The endpoint named "create page" would secretly create redirects.
- **C: Compose two existing calls from client** (`POST /api/pages` then `POST /api/pages/:name/archive`) — two writes, two history revisions, two audit events. Contradicts the issue's "one history revision per redirect" acceptance criterion. Creates a window where the manifest exists as a live page before being archived.
- **A2 sentinel template `'__redirect__'`** — tribal-knowledge bait. Future readers seeing the value in storage wonder what it does.

### Q3 — SiteTree "+ New" menu entry

New "+ New redirect" button in SiteTree.vue's create-affordance row, alongside existing "+ New page" and "+ New fragment". Opens new `CreateRedirectDialog.vue` peer to `CreatePageDialog.vue` / `CreateFragmentDialog.vue` — reuses morph-in-place dialog pattern + `ArchivedNameConflictPrompt.vue` (already designed for this collision class).

**Rejected alternatives:**
- **B: Top-bar action under active-target menu** — splits the mental model (page creation in tree, redirect creation in top bar). Asymmetry without reason.
- **C: Dedicated `/admin/redirects` page** — overkill for v1. The list view is already covered by tree+"Show archived" filter (existing tree visual: `landing → welcome` for redirects, plain `archived` for pure soft-deletes). WordPress's `/admin/redirects` page exists because WP has no equivalent of "Show Archived." Gazetta does.
- **D: Co-locate in "Show archived" filter** — hides creation behind a toggle. New operators won't think "I need to toggle Show Archived to create a redirect." Discoverability fails Krug.

**Why A is minimal viable**: Q1=C committed to "Redirect as first-class noun." The "+ New" menu literally lists Page, Fragment, Redirect as creatable things. Same Krug-aligned affordance shape as adjacent operations.

**Risk**: site with 100+ redirects scrolls a tall tree. Mitigation: `design-scale.md` ships tree virtualization (per [#88](https://github.com/gazetta-studio/gazetta-studio/issues/88)). Independent of this feature.

**Future revisit**: dedicated `/admin/redirects` page lands additively if operator demand surfaces — bulk import, 404-log-to-redirect, etc. A doesn't preclude it.

### Q4 — From-route normalize-to-name + hard-refuse live collision

**Input shape:** Accept either `/old-products` or `old-products` in the from-route input. Normalize to `old-products` for storage (strip leading slash, convert `:param → [param]`). Show resolved route as Krug-style preview below the input:

```
Redirect from
[ /old-products      ]
  Will redirect: /old-products

Redirect to
[ products/featured  ]
  Will redirect to: /products/featured
```

Combines clipboard-friendliness (operators paste URLs from analytics) with the project's name-shaped storage convention.

**Live-name collision (`from` is a live page):**

Hard-refuse with `409 LIVE_NAME_CONFLICT`. Clear message: "The page `products` already exists. To redirect this URL, first archive or rename `/products`, then create the redirect." **No destructive shortcut from the redirect dialog.** Operator's deliberate two-step protects against accidental live-page removal.

**Archived-name collision (`from` is already an archive):**

Reuse soft-delete Q5's existing `ARCHIVED_NAME_CONFLICT` prompt. Three options: Restore (default) / Replace / Move aside / Cancel. Implemented via `ArchivedNameConflictPrompt.vue` (already ships).

**Missing alias target (`to` doesn't exist):**

Client pre-flight via site tree state (operator typing `to` field gets autocomplete from live page/fragment list). Server backstop: `409 ALIAS_TARGET_NOT_FOUND`.

**Rejected alternatives:**
- **Pure B (name-only input, no slash accepted)** — fails the clipboard-paste-from-analytics use case
- **C1 (allow archiving existing live page from the redirect prompt)** — one-click destructive shortcut from a creation dialog. High blast radius for marginal convenience.
- **D (allow shadow + warn)** — doesn't apply for live-name collisions. Two manifests can't coexist at the same path.

### Q5 — Same as any archive; explicit publish

Manual Redirect manifest lives on source target. Propagates to staging/production via standard `gazetta publish`. Sync indicators show "staging: 1 behind" until publish.

**Rejected: B (auto-publish to all editable targets).** Violates `design-decisions.md` #16 (publish-direction is author-chosen, system-suggested, never system-decided). Plain-static targets can't enforce 301; auto-publish would silently emit a non-functional redirect there.

**No new code needed.** Existing publish flow already handles archived items (verified in `publish-rendered.ts`: `if (isArchived(page)) return publishArchiveMarker(...)`). Manual Redirects are bytes-identical to Rename Redirects from the publish flow's POV.

### Q6 — Both pages and fragments in v1

Dialog has a kind toggle (page | fragment) at the top. UI parity prevents asymmetric "+ New" menu confusion.

**Why B over pages-only:**
- Fragment archive+aliasOf mechanism already ships at route + schema layer (verified in `fragments/create.ts`). Implementation cost is one schema field + dialog toggle.
- The CONTEXT.md Redirect entry locks language to "Page **or** Fragment" — pages-only would contradict the glossary.
- If pages-only ships and B becomes operator demand later, design grilling repeats.

**Risk**: ~50-80 lines additional implementation. Acceptable given mechanism reuse.

### Q7 — New `action: 'create-redirect'` audit enum value

Closed-enum-additive (matches soft-delete's pattern of `archive`/`unarchive`/`purge`/`rename`). Audit event shape:

```jsonc
{
  "action": "create-redirect",
  "outcome": "success",
  "actor": { ... },
  "scope": { "kind": "page", "name": "old-products" },  // or "fragment"
  "metadata": { "aliasOf": "products/featured" }
}
```

**Why B over `metadata.manual: true`:**
1. Pattern consistency with soft-delete (intent → enum value, not metadata flag).
2. `AuditQuery.action` natively supports filtering. Closed-enum discrimination beats soft metadata filtering for forensic reliability (OP5: "show all manual redirects last week").
3. Q1's CONTEXT.md lock already calls out that "the distinction matters for forensic queries" — using the weaker discriminator (metadata) contradicts the locked entry.

**Risk**: audit `AuditAction` enum grows. Today 13 values; this adds one. Pattern is documented as additive-closed-enum-extension; growth is acknowledged trade-off.

### Q8 — `edit:pages` / `edit:fragments` capability

**Overrides original issue body's `delete:pages` claim.** Grilling surfaced the precedent: `PATCH /api/pages/:name/alias` in `archive.ts:163` uses `edit:pages` ("alias is a content-state edit, not destruction"). Manual Redirect creation is the SAME operation but in create-mode — symmetric capability choice.

**Why B over `delete:pages`:**
- Creating a redirect adds new state. Doesn't remove live content (Q4 lock C2 hard-refuses on live collision).
- `delete:*` semantically gates "remove live content." Creating new state isn't that.
- Editor role (`read:* + edit:* + publish:non-production`) can now create redirects without admin help. Matches Gazetta's team-CMS operator-trust model. Marketing editor needing to redirect `/promo` to a campaign page works without admin intervention.

**Rejected alternatives:**
- **A: `delete:pages`** — conservative but contradicts the PATCH alias precedent.
- **C: New `create:redirect` capability** — over-engineered. Splits namespace further with zero marginal value over B.

**Risk**: an editor can create redirects for pages they didn't author. Mitigation: every Manual Redirect emits the `create-redirect` audit event (Q7) with editor identity; forensic surface covers it.

## Foundational checks

### Multi-instance
- Manifest writes are last-write-wins per soft-delete pattern. Two operators creating same `/from` simultaneously race per existing save concurrency.
- No new cross-instance state.
- Audit event recording fans out parallel per `design-audit.md` Q3.

### Scale
- Redirect count bounded by archive count (subset). Already in soft-delete's envelope (5K pages).
- Tree-view scaling depends on `design-scale.md`'s pending virtualization (#88) — same dependency as archives. Independent of this feature.

### Locale
- `aliasOf` resolves to a target NAME (locale-agnostic per soft-delete Q1). Locale routing handles the rest. Per-locale redirect creation reserved (ROADMAP "per-locale archive" future direction).

### Themes
- Theme-agnostic. Redirects are URL → URL.

### Auth + RBAC
- Capability: `edit:pages` / `edit:fragments` per Q8.
- Trust modes compose normally: no special-case for Manual Redirects.
- Principal recorded on audit event per existing pattern.

### Audit
- New action: `create-redirect` (Q7). Metadata: `{ aliasOf }`. Scope: `{ kind, name }`.
- Forensic query: `AuditQuery.action = 'create-redirect'` filters to this feature.

### Review
- Manual Redirect creation is save-class (writes a manifest). Auto-withdraw / restore-to-draft semantics per soft-delete Q9 N/A — no preceding state.
- Future review-workflow integration: redirect creation could theoretically traverse `pending-review`. Not in scope; revisit when review-workflow implementation ships.

### Hooks
- `beforeSave` / `afterSave` fire (manual redirect IS a save). No new hook phases needed.

### Rendering
- Render mechanism unchanged. HTML comment marker / `_redirects` row emitted identically to Rename Redirects.

### Validation
- Existing validators apply: `dangling-alias` (error) fires if `to` doesn't resolve. Pre-flight in dialog catches the common typo BEFORE 409.
- `aliasOf-points-to-archived` (warn) — fires if operator creates a redirect to a target that becomes archived later.
- `archive-not-supported-on-target` (warn) — fires on plain-static targets per capability-gap UX.

### Plugin
- No new extension surface. Reuses soft-delete primitives.

### Cache
- Manual redirect creation invalidates `pages:` / `fragments:` prefix (existing pattern from archive route).
- Pre-publish preview reflects redirect intent (existing preview iframe shows "301 → /target" placeholder per soft-delete Q7).

### Offline
- Create-redirect operation queues + replays on reconnect per existing save replay pattern.
- Conflict shape: if from-name becomes live on reconnect (another operator created `/from` while you were offline), replay fails with `LIVE_NAME_CONFLICT` per the standard offline conflict UX.

### Collaboration
- No comments / mentions / activity-feed concerns in v1.

## Distinctive choices

- **Schema refinement over sentinel template**: cleanest reflection of runtime reality (archived pages never have template executed). Tribal knowledge avoided.
- **No `/admin/redirects` page in v1**: tree+filter handles list view. Dedicated page lands additively if demand surfaces.
- **Hard-refuse on live collision (no shortcut)**: blast-radius protection. Operator's two-step protects against silent live-page removal.
- **Edit-class capability, not delete-class**: matches PATCH alias precedent. Adds state, doesn't destroy.
- **Closed-enum-additive for audit discriminator**: pattern consistency with soft-delete.

## Migration

No migration. Existing rename-via-soft-delete continues unchanged. Manual Redirects are a new operation that uses already-shipped primitives.

## Open implementation questions

1. **Conditional schema refinement shape.** Zod `.refine` vs `z.discriminatedUnion` — which is cleaner for "template required when not archived"? Pick at implementation time after seeing the diff.
2. **`alias` autocomplete data source.** Server-side route or client-side query against existing site store? Client-side is faster; revisit if 5K-page envelope makes autocomplete-on-keypress slow.
3. **Krug-test the form copy.** Labels per bot's research note: "URL that should redirect" vs "Redirect from" + "Redirect to" / "Source URL" + "Destination URL". Lands during implementation Cut 3 (dialog).
4. **Capability-gap modal copy.** When active target is plain-static: "On this target, manual redirects won't fire — switch to a worker-capable target, or configure `_redirects` format." Draft + test during implementation Cut 3.
