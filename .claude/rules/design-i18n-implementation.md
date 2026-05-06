---
paths:
  - "packages/gazetta/src/cli/translate.ts"
  - "packages/gazetta/src/cli/validate.ts"
  - "apps/admin/src/client/components/EditorPanel.vue"
  - "apps/admin/src/client/composables/useEditorActions.ts"
---

# i18n / Locale — Implementation

Companion to [design-i18n.md](design-i18n.md). Tracks the remaining implementation work; the bulk of the design has shipped.

See [design-i18n.md](design-i18n.md) for the design itself.

## Status

13 of 15 implementation steps have shipped (whole-file locale variants, file-suffix model, fallback chain, hreflang, sitemap, admin locale picker, CLI translate, language detection). Two steps remain. Per-field translation (#192) is the next major chunk and gets its own implementation pass — the design/implementation split for this doc happens when #192 lands.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

The cuts are small and independent — they don't compose into a single branch. Each ships standalone where the design pass anticipated.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | Admin "Translate to..." action — design-i18n step 12 | ☐ | Low | Author UX |
| 2 | `gazetta validate` locale-file checks — design-i18n step 15 | ☐ | Low | Validation surface |
| 3 | Per-field translation (#192) — major: design pass + implementation cuts | ☐ | High | Per-field overlay model |

## Per-cut scope

### Cut 1: Admin "Translate to..." action (step 12)

**What ships:** an admin UI affordance that creates a new locale variant of the current page or fragment, pre-filled from the default locale's content. Author opens a page, clicks "Translate to French," and lands in `page.fr.json` with the default locale's content as a starting point.

**Files added/modified:**
- `apps/admin/src/client/components/EditorPanel.vue` — "Translate to..." button in the locale picker / metadata area; opens a small dialog listing supported locales not yet present for this manifest
- `apps/admin/src/client/composables/useEditorActions.ts` — new `translateTo(targetLocale: string)` function: POST to a new admin-API route that creates the locale variant
- `packages/gazetta/src/admin-api/routes/pages.ts` + `fragments.ts` — `POST /api/pages/:name/translate` body `{ to: string }`. Server reads the default-locale manifest, writes a new `{name}.{locale}.json` with the same content; rejects 409 if the variant already exists; rejects 400 if `to` not in `locales.supported`

**Why "pre-fill from default" not "create empty":** zero-friction. Author sees the structure they're starting from and edits in place; an empty form forces them to mentally rebuild the page from scratch. CLI `gazetta translate` already does this; admin UI mirrors that behavior.

**Tests:**
- `admin-api.test.ts` — POST translate creates the locale file with default's content; second POST returns 409
- Unsupported `to` returns 400
- Vue component test: button hidden when all locales already exist; click opens dialog; selection navigates to new editor

**Trigger to ship:** alongside the editor papercut cluster (Tier 1) when author UX work picks up; or as its own commit when authors ask.

**Risk:** low. The server-side write is well-understood; the UI adds a button next to the existing locale picker.

**SOLID:** SRP — `translateTo` is its own composable function; doesn't mix with general save/navigate. ISP — the new route is its own admin-API endpoint with a small Zod schema, not a flag on an existing route.

### Cut 2: `gazetta validate` locale-file checks (step 15)

**What ships:** validation of locale-variant manifests at the CLI level. Catches structural breaks specific to multi-locale sites: orphaned variants (e.g., `page.fr.json` exists but `page.json` doesn't), invalid locale codes, locale files referencing fragments that don't have matching locale variants.

**Files added/modified:**
- `packages/gazetta/src/validation/validators/orphaned-locale-file.ts` (NEW) — already listed in `design-validation.md` as a background-only validator; ship its CLI integration here
- `packages/gazetta/src/validation/validators/locale-code-valid.ts` (NEW) — validates each variant's locale code is in `locales.supported`; rejects malformed locale codes
- `packages/gazetta/src/cli/validate.ts` — wire the two new validators into the CLI run
- `gazetta validate --include-locale` flag (or always-on; locked at implementation time) to enable the locale-specific checks

**Tests:**
- `tests/validation-locale.test.ts` — orphan variant detected; invalid locale code reported with the file path; valid locale variant passes
- CLI integration: exits 1 on orphan variant; exits 0 with the flag off

**Trigger to ship:** with validation Cut 5 (CLI rewrite per `design-validation-implementation.md`). The CLI rewrite already has this in its scope.

**Risk:** low. Pure-function validators; no UI; no migration.

**SOLID:** OCP — new validators slot into the existing registry without touching infrastructure.

### Cut 3: Per-field translation (#192)

**What ships:** layered per-field translation overlay on top of the existing whole-file model. Per `design-i18n.md` "Per-field overlay model": each manifest can carry per-locale per-field overrides instead of (or in addition to) a full locale-variant file. Useful for "translate just the title and description" without copying the full structure.

**This cut is a design-and-implement at-once.** The design space is open in `design-i18n.md` — the locked invariant says "Per-field overlay model (asset-side, future for pages/fragments)" — pages/fragments need a design pass for the overlay shape (where do overrides live? merged at read time? per-locale arrays in the manifest? sidecar files? merged before validation or after?).

**Implementation phases** (sequenced after the design pass):

1. **Design grilling** (1 week): merged at read or write? per-locale arrays in manifest, or sidecar `page.fr.overlay.json`? schema validation: full manifest after merge, or per-overlay? component-level overrides (per `design-collaboration.md` Component IDs)?
2. **Schema + types** (~3 days): manifest shape supports overlay; loader merges per-locale overrides; renderer sees the merged manifest
3. **Admin UI** (~5 days): per-field "translate this field" affordance; per-field locale picker
4. **Migration** (~2 days): existing whole-file variants continue to work; operators opt into per-field per file (`page.fr.json` becomes `page.json` + `page.fr.overlay.json` if they choose)
5. **Validation** (~2 days): locale-aware altRequired and quality validators understand merged manifests
6. **Docs** (~2 days): operator + template-author guide

**Total estimate:** ~3 weeks including the design grilling. Sized after the design pass.

**Trigger to ship:** Tier 2 / Phase 2 work per ROADMAP. Concrete demand pushes priority.

**Risk:** high. The design pass is open; wrong shape forces a future migration. Component IDs (Phase 1 foundation) is a likely prerequisite for component-level overrides.

**Why this cut is a placeholder:** the meaningful work is the design pass that locks the overlay shape. Once locked, the implementation cuts get their own per-cut breakdown and SOLID checks. Capturing #192 here as "the next big chunk for i18n" rather than punting it.

## Validation gate (definition of done)

Cuts 1 and 2 are independent; each has its own done definition.

**Cut 1 done:**
- [ ] "Translate to..." button visible when locales are unfilled
- [ ] POST creates the locale variant; 409 on existing; 400 on unsupported locale
- [ ] After click, author lands in the new editor with default's content

**Cut 2 done:**
- [ ] `gazetta validate` reports orphan variants with the file path
- [ ] `gazetta validate` reports invalid locale codes
- [ ] CLI Cut 5 (validation rewrite) integrates these checks

**Cut 3 done:**
- [ ] Design pass landed in `design-i18n.md` (or a successor doc)
- [ ] Implementation cuts split out and shipped
- [ ] Backwards-compatible with existing whole-file variants
- [ ] Author can mix whole-file + per-field per page

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Locale-aware comments per `design-collaboration.md` future | Concrete demand |
| Per-locale CDN cache invalidation | Multi-region operator demand |
| Auto-translate on save (vs manual `gazetta translate`) | Operator asks; depends on AI translation cut shipping |
| RTL-specific admin chrome (beyond document `dir`) | Arabic / Hebrew operators report friction |
| Pluralization conventions | Concrete content authoring demand (current model: each form is its own field) |

## Open implementation questions

1. **"Translate to..." dialog default behavior.** Should it pre-fill from default locale, or from a chosen source locale? Recommend default-locale (matches CLI). Locked at cut 1.
2. **Per-field overlay shape (cut 3).** The big question. Options listed in cut 3 above; needs a grilling pass.
3. **Invalid locale code in URL.** What does `?locale=invalid` do today? Per the codebase: falls back to default. Document the behavior in `docs/i18n.md` and add a test.

## Estimates

Wall-clock for solo dev:

| Cut | Estimate |
|---|---|
| 1 (Admin "Translate to...") | 1.5 days |
| 2 (CLI validate locale checks) | 1 day (lands with validation Cut 5) |
| 3 (Per-field translation #192) | ~3 weeks (design + impl) |

**Cuts 1+2 total: ~2.5 days.** Cut 3 sized after its design pass.

## SOLID checks per cut

- **Cut 1**: SRP — `translateTo` composable owns "create locale variant from default"; route handler owns server-side write. DIP — UI consumes the route via the existing api client; doesn't reach into the server.
- **Cut 2**: OCP — validators slot into the existing `Validator` registry without changing infrastructure.
- **Cut 3**: deferred — SOLID review at design-pass time.
