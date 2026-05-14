# Redirect UI — Implementation

Companion to [`design-redirect-ui.md`](design-redirect-ui.md). Cut sequence with risk ordering, per-cut scope, deferred items.

See `design-redirect-ui.md` for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `redirect-ui-v1` off `main`. **No backwards compatibility** — additive only; existing soft-delete operations unaffected.

Sequenced data-shape-first (schema refinement + audit enum), then engine (route handler), then UX (dialog + tree button), then validation gates. Each cut is independently rollback-able.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | Schema refinement: `template` conditionally optional when `archived: true` (PageManifest + FragmentManifest) | ☐ | Low | Type contract; no runtime behavior change |
| 2 | New audit action enum: `'create-redirect'` | ☐ | Low | Audit type contract; no recording yet |
| 3 | `POST /api/redirects` route + Zod request/response schemas | ☐ | Medium | Server contract for manual redirect creation |
| 4 | `CreateRedirectDialog.vue` + SiteTree "+ New redirect" button | ☐ | Medium-high | The visible UX |
| 5 | Conflict UX: live-name collision (`LIVE_NAME_CONFLICT`) + reuse soft-delete `ArchivedNameConflictPrompt.vue` for archived-name | ☐ | Medium | Operator-facing error paths |
| 6 | Capability-gap UX integration (boot validate / author modal / scanner / publish gate) — verify existing four-point pattern covers Manual Redirects | ☐ | Low | Composition with existing pattern |
| 7 | E2E + docs (extend `docs/soft-delete.md` with Manual Redirect section; possibly new `docs/redirects.md` user guide) | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: Schema refinement

**Files modified:**
- `packages/gazetta/src/admin-api/schemas/pages.ts` — `PageManifestSchema` (the persisted shape) gains `.refine` or `z.discriminatedUnion` to allow `template` absence when `archived: true`. Note: `CreatePageRequestSchema` (the create-page contract) remains unchanged — page creation still requires template.
- `packages/gazetta/src/admin-api/schemas/fragments.ts` — same shape for fragments.
- `packages/gazetta/src/types.ts` — `PageManifest.template` / `FragmentManifest.template` become `string | undefined`.

**Tests:**
- Schema parses archive-only manifest `{ archived: true, aliasOf: 'x' }` without error
- Schema rejects live manifest without template (existing behavior preserved)
- Type-level: `Page.archived === true && !Page.template` is well-typed

**Why first:** lowest blast radius. Pure data-shape change; no consumers exercise it until Cut 3. If the schema shape is wrong, reverting one file rolls back.

**SOLID:** SRP — schemas live in their existing modules; refinement is additive.

### Cut 2: Audit action enum

**Files modified:**
- `packages/gazetta/src/audit/types.ts` — append `'create-redirect'` to `AuditAction` type union.
- `design-audit.md` documentation update (if the action enum is enumerated there — it is, line 122-ish).

**Tests:**
- Type-level: `AuditEvent.action = 'create-redirect'` compiles
- Schema parse: audit event with `action: 'create-redirect'` round-trips through serialization

**Why second:** type-only foundation for Cut 3 to consume.

### Cut 3: `POST /api/redirects` route

**Files added:**
- `packages/gazetta/src/admin-api/routes/redirects.ts` — Hono route handler:
  - `app.post('/api/redirects', requireCapability(kind === 'fragment' ? 'edit:fragments' : 'edit:pages'), ...)` — Per Q8 lock. Capability gate may need `requireCapability` enhancement to compute capability from request body's `kind` field — verify pattern against existing kind-aware routes. Fallback: dispatch to two separate handlers `/api/page-redirects` and `/api/fragment-redirects` if the dynamic capability check is awkward.
  - Validate body via `CreateRedirectRequestSchema`
  - Check live-name collision → `409 LIVE_NAME_CONFLICT` per Q4
  - Check archived-name collision → reuse soft-delete's `409 ARCHIVED_NAME_CONFLICT` (and `?onConflict=restore|replace|moveAside` handling per soft-delete Q5)
  - Check alias target exists → `409 ALIAS_TARGET_NOT_FOUND`
  - Write manifest atomically with `{ archived: true, archivedAt, archivedBy, aliasOf, name }` — no template field
  - Record one history revision
  - Emit one audit event with `action: 'create-redirect'`, `metadata: { aliasOf }`
  - Invalidate `pages:` or `fragments:` cache prefix
  - Return 201 with response shape
- `packages/gazetta/src/admin-api/schemas/redirects.ts` — Zod request/response schemas (per MCP discipline):
  ```ts
  export const CreateRedirectRequestSchema = z.object({
    from: z.string().min(1),     // accepts /old-products or old-products (normalize server-side)
    to: z.string().min(1),       // target name (live)
    kind: z.enum(['page', 'fragment']),
  })
  export const CreateRedirectResponseSchema = z.object({
    ok: z.boolean(),
    from: z.string(),
    to: z.string(),
    kind: z.enum(['page', 'fragment']),
    route: z.string(),           // derived route for from
    targetRoute: z.string(),     // derived route for to
  })
  ```
- `packages/gazetta/src/admin-api/index.ts` — register the new route.

**Tests:**
- Happy path: page redirect creation → 201 + correct response shape + manifest at `pages/{from}/page.json` with archive fields + audit event with correct action
- Happy path: fragment redirect creation → same shape with `fragments/{from}/fragment.json`
- Normalize input: `/old-products` and `old-products` both work; both produce manifest at `pages/old-products/page.json`
- Live-name collision → 409 `LIVE_NAME_CONFLICT` with clear message
- Archived-name collision → 409 `ARCHIVED_NAME_CONFLICT` with archive details (reuses soft-delete shape)
- `?onConflict=restore` on archived-name collision → unarchive existing, skip create (matches soft-delete Q5)
- `?onConflict=replace` → atomic purge + create
- `?onConflict=moveAside` → rename old archive with timestamp, create new
- Missing alias target → 409 `ALIAS_TARGET_NOT_FOUND`
- Missing capability → 403 `FORBIDDEN`
- One history revision per success (atomicity check)
- Audit event has correct action + actor + scope + metadata

**Risk:** medium. New server contract; correctness depends on right capability gate + right conflict resolution. Reuses soft-delete primitives where possible.

**SOLID:** SRP — `redirects.ts` owns the redirect-creation route; doesn't reach into archive/create internals. DIP — depends on existing archive primitives via narrow imports.

### Cut 4: `CreateRedirectDialog.vue` + SiteTree button

**Files added:**
- `apps/admin/src/client/components/CreateRedirectDialog.vue` — peer to `CreatePageDialog.vue`:
  - Two text inputs: from (URL or name) + to (target name)
  - Krug-style resolved-route preview below each input
  - Kind toggle (page | fragment) at the top
  - Alias target autocomplete from existing site store (live pages/fragments only)
  - Submit button: "Create redirect"
  - On 409 LIVE_NAME_CONFLICT: show error message inline ("The page `products` already exists...")
  - On 409 ARCHIVED_NAME_CONFLICT: morph in place to `ArchivedNameConflictPrompt.vue` (already ships)
  - On 409 ALIAS_TARGET_NOT_FOUND: show error inline

**Files modified:**
- `apps/admin/src/client/components/SiteTree.vue` — add "+ New redirect" button after the existing "+ New fragment" button, opens `CreateRedirectDialog.vue`
- `apps/admin/src/client/stores/site.ts` (if needed) — wire dialog open state, optimistic update on success

**Tests:**
- Vue Test Utils: dialog opens; both inputs accept URLs and names; resolved route preview updates live
- Vue Test Utils: kind toggle switches between page/fragment modes; alias autocomplete updates
- Vue Test Utils: submit calls `POST /api/redirects` with correct body
- Vue Test Utils: 409 LIVE_NAME_CONFLICT shows inline error
- Vue Test Utils: 409 ARCHIVED_NAME_CONFLICT morphs to conflict prompt
- E2E: full flow create redirect → see in SiteTree under "Show archived" → preview iframe redirects from old route to new

**Risk:** medium-high. Visible UX; misalignment with Cut 3 contract breaks operator trust. Heavy on E2E.

**SOLID:** SRP per component. Composition over inheritance — `ArchivedNameConflictPrompt.vue` is consumed not extended.

### Cut 5: Conflict UX edge cases

This cut may fold into Cut 3+4 if the implementation surfaces no additional edge cases. Reserved as a separate cut for risk isolation.

**Files modified:**
- `apps/admin/src/client/components/CreateRedirectDialog.vue` — refine error messages based on operator feedback during E2E
- `packages/gazetta/src/admin-api/routes/redirects.ts` — add `?onConflict` query param handling if not in Cut 3
- New tests covering edge cases surfaced during implementation

**Tests:**
- Edge case: from-route is `home` (resolves to `/`) — what's the UX?
- Edge case: from-route contains `[param]` (dynamic route segment) — accept or reject?
- Edge case: to-name has locale variants — does redirect work for all locales?

### Cut 6: Capability-gap UX integration

**Files modified:**
- `apps/admin/src/client/components/CreateRedirectDialog.vue` — add per-target capability badges (per soft-delete Q10 four-point pattern):
  - Boot validate: existing warning at admin start when target lacks redirect capability
  - Author-time modal: dialog shows badges like "On `staging`: 301 ✓ • On `production-static`: 404 (no worker) ⚠"
  - Scanner: existing `archive-not-supported-on-target` validator already covers
  - Publish gate: existing pre-publish modal already lists per-target compatibility issues

**Tests:**
- Plain-static target → dialog shows capability-gap warning before submit
- Worker-served target → no warning
- Boot validate: target with `runtime: 'plain-static'` and Manual Redirects exist → boot warning

**Risk:** low. Pattern already shipped for soft-delete; this is composition.

### Cut 7: E2E + docs

**Files added:**
- `tests/e2e/scenarios/manual-redirect.spec.ts` — full creation journey
- New section in `docs/soft-delete.md` titled "Manual redirect creation" with operator walkthrough
- Update `CONTEXT.md` section "Soft delete and redirects" if any term needs refining post-implementation
- Update `ROADMAP.md` "Now" section to mark Redirect UI shipped

**Files modified:**
- `docs/soft-delete.md` — add the section
- `ROADMAP.md` — move from "Now" to appendix

**Risk:** low. Code is stable; docs reflect reality.

## Validation gate (definition of done)

- [ ] All 7 cuts merged
- [ ] Manual test: create a redirect from `/old` to `/new`; publish; verify worker emits 301 from old route
- [ ] Manual test: create redirect with live-name collision → 409 with clear message; no destructive shortcut visible
- [ ] Manual test: create redirect with archived-name collision → soft-delete Q5 prompt fires
- [ ] Manual test: capability-gap warning visible on plain-static target
- [ ] Audit log shows `create-redirect` event for each creation
- [ ] Operator can create a redirect in <30 seconds (per #364 acceptance criterion)

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Dedicated `/admin/redirects` list page | Operator demand for bulk import / 404-log-to-redirect / volume past tree-filter ergonomics |
| Bulk CSV import | WordPress-style operator demand |
| 404-log-to-redirect path | Gazetta gains a 404 log primitive |
| Wildcard / regex from-routes | Operator demand for URL-pattern redirects |
| Conditional redirects (login state, browser, etc.) | Strategic non-fit candidate; not currently demand-driven |
| 302 / scheduled / time-bounded redirects | Scheduling primitive implementation ships; compose then |
| Per-locale redirect creation | Per-locale archive demand surfaces |

## Open implementation questions

1. **Conditional schema refinement shape.** `z.refine` (predicate-based, simpler) vs `z.discriminatedUnion` (cleaner narrowing, more verbose). Pick at Cut 1 after seeing the diff. Same call to make consistently for PageManifest + FragmentManifest.

2. **Dynamic capability check in Cut 3.** `requireCapability` middleware factory currently takes a literal capability string. Two paths if the body's `kind` field can't drive the gate cleanly:
   - **(a)** Two routes: `POST /api/page-redirects` + `POST /api/fragment-redirects`. Splits the URL surface but each gate is literal.
   - **(b)** Single route + custom middleware that reads body. More flexible but a one-off pattern.

   Recommendation: try (a) first if the dynamic check requires bespoke middleware. Two routes with shared handler body is cheap.

3. **Krug-test the form copy.** Per bot's research note. Labels to A/B in implementation:
   - "URL that should redirect" / "Where it should go" — most plain
   - "Redirect from" / "Redirect to" — terser, parallel
   - "Source URL" / "Destination URL" — technical

   Recommendation: "Redirect from" / "Redirect to" — parallel structure beats varied wording.

4. **`home` page redirect edge case.** Operator creates `from: 'home'`. The `deriveRoute('home') = '/'` mapping means this would redirect `/` to the alias target. Is that a feature or a footgun? Probably reject in v1 (server-side check: `if (from === 'home') return 400 INVALID`); revisit if operator demand surfaces.

5. **Dynamic route from-route (`[slug]`).** Operator types `from: 'blog/[slug]'`. Should that redirect every `/blog/X` to alias target? Probably reject in v1 — wildcard redirects are deferred.

6. **Alias target with locale variants.** Operator creates redirect with `to: 'products/featured'`. If `products/featured.fr.json` exists, does the redirect work for French requests too? Should — alias target resolution is locale-agnostic per soft-delete Q1. Verify in Cut 3.

## Test infrastructure

- Cut 3 reuses existing `admin-api.test.ts` patterns for Zod schema validation
- Cut 4 adds new component test file `CreateRedirectDialog.test.ts`
- E2E reuses existing per-worker temp-site pattern from `tests/e2e/fixtures.ts`

## Estimates

| Cut | Estimate |
|---|---|
| 1 (Schema refinement) | 0.5 day |
| 2 (Audit enum) | 0.5 day |
| 3 (Route + schemas) | 1.5 days |
| 4 (Dialog + tree button) | 2 days |
| 5 (Conflict UX edge cases) | 0.5-1 day (may fold into 3+4) |
| 6 (Capability-gap UX) | 0.5 day |
| 7 (E2E + docs) | 1 day |

**Total: ~6 days.** Budget ~1 week with iteration on Cuts 3-4 (the high-risk surfaces). Matches ROADMAP's 1-week estimate.

## SOLID checks per cut

- **Cut 1**: SRP — schema modules unchanged in scope; refinement is additive
- **Cut 2**: SRP — audit enum extension; no module boundary change
- **Cut 3**: SRP — new route file owns redirect creation; doesn't reach into archive/create internals. DIP — depends on existing archive primitives via narrow imports
- **Cut 4**: SRP per component; composition over inheritance — `ArchivedNameConflictPrompt.vue` consumed not extended
- **Cut 5**: SRP — error UX is component-local; doesn't bleed into server handler
- **Cut 6**: composition with existing soft-delete capability-gap pattern; no new module needed
- **Cut 7**: docs and E2E; no SOLID concerns beyond doc discipline
