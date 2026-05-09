# Actor Scenarios

Canonical task narratives for the four actor types Gazetta serves
(per [`CONTEXT.md`](../CONTEXT.md#actors)). Every new feature design
checks itself against the relevant scenarios — does this feature
make the scenario better, worse, or unchanged?

**Provenance** (per [team-preferences rule 27](../.claude/rules/team-preferences.md)):
this scenario corpus is intuition-derived from CMS pattern matching
+ the soft-delete + scheduling design work of 2026-05. It's a
starting yardstick, not validated user research. Watching real
users (per the practices catalogued in the soft-delete session
retrospective) is the next step; until then these scenarios are
informed guesses, useful for self-checking but not authoritative.

**Why a scenario corpus**: every UX-grilling pass per
[`feature-design-process.md`](../.claude/rules/feature-design-process.md)
phase 2a needs concrete "who is the user, what are they trying to
do?" prompts. Without canonical scenarios, every feature design
re-invents the user, and consistency suffers. The corpus is a
small set of representative tasks; not exhaustive.

## How to use this doc

When designing a feature with UX surface, identify which actor(s) it
affects and walk the relevant scenarios:

1. **For each affected scenario**, ask: "after this feature ships,
   does this scenario get better, worse, or unchanged?"
2. **For the worsened ones**, ask: "is the cost worth it? what would
   make it not worsen?"
3. **For the unchanged ones**, ask: "did we miss an opportunity to
   improve this scenario at the same time?"

The scenarios aren't a checklist; they're a yardstick.

## Scope notes

- v1 scope: 4 actors × ~4 scenarios each = ~16 scenarios. Lean
  intentionally; expanding is cheap, pruning is harder.
- Each scenario describes "the daily friction shape" — not the
  happy-path demo, not the pathological worst case.
- Scenarios assume the current design surface (post-soft-delete,
  post-scheduling, pre-collaboration). They evolve as features ship.

---

## Content Author scenarios

The person editing content through the admin UI form editor.

### CA1: Daily blog post (write + publish)

Author opens admin, clicks "New page" under blog, fills the title +
body fields, drops in a hero image, clicks Save. Reviews preview.
Clicks Publish to staging. Reviews on staging. Clicks Publish to
production.

**Friction shapes to watch:**
- "New page" surface — discoverable from the tree, no nested menus
- Form layout — common fields visible without scrolling
- Image upload — drag-drop works; alt-text suggestion fires fast (per
  `design-ai.md`); upload doesn't block the form
- Save → preview lag — sub-second; preview reflects the saved state
- Publish dialog — environment chrome makes prod vs staging
  unmistakable; one click for staging, confirmation for prod
- After publish — cache invalidation visible; new content appears at
  the URL within seconds

**What we tend to optimize for**: clean empty-site demo flow.
**What gets ignored**: the friction of doing this 50 times a week.

### CA2: Multi-locale page (translate + publish to multi-domain)

Author has a page in English. Switches active locale to French via
the top-bar locale picker. Sees the page is missing French content.
Clicks "Translate to French" (or copies from English manually).
Edits French content. Saves. Switches active target to a French-
specific production target. Verifies the page renders correctly with
French content + French URL. Publishes.

**Friction shapes to watch:**
- Locale picker discoverability — finding it shouldn't require a tour
- Missing-locale state — "translate from..." action visible, with the
  source locale's content prefilled
- Locale-target binding — the active target's locale subset is
  obvious; per-domain deployment doesn't require holding a mental map
- Cross-locale fallback in preview — when French is incomplete,
  preview shows what visitors would see
- Hreflang / SEO — author shouldn't have to think about this; it
  should "just work" per `design-i18n.md`

### CA3: Bulk content edit (10+ pages in one session)

Author needs to update a copyright year across 50 pages, or
add a new fragment to every page in the blog directory, or fix
a typo that appears on multiple pages. Currently: page-by-page
in admin or hand-edit JSON files.

**Friction shapes to watch:**
- Discovery: how does the author find all affected pages?
  (Search? Walk the tree? `gazetta validate` warnings?)
- Bulk action surface — none today; manual per-page edit is the path
- Save → next page navigation — does the active edit context survive
  navigation? Does pending-edits get lost?
- Confirmation: did all 50 pages save successfully? Any failed?

**What we tend to optimize for**: one-page-at-a-time workflow.
**What gets ignored**: the 10x case is normal, not exceptional.

### CA4: Recovering from a save conflict

Author edits page A. While editing, a colleague (or another tab)
saves page A first. Author clicks Save. Server returns 409 STALE
(per `design-offline.md` Q3). Conflict banner appears.

**Friction shapes to watch:**
- Banner clarity — "Was edited by someone else" not "STALE conflict"
  (per Krug rule 23)
- Diff visibility — author can see what changed without leaving the
  editor
- Resolution — author either discards their changes or manually
  re-applies them on top of the new version (no force-overwrite —
  locked invariant per `design-offline.md`)
- Cost of resolution — sub-minute for typical conflicts (one or two
  fields), not a full re-edit

**What we tend to optimize for**: single-author flow.
**What gets ignored**: every team CMS hits this case daily.

---

## Template Developer scenarios

The person creating templates and custom editors/fields in a
Gazetta project (`templates/`, `admin/`).

### TD1: Adding a new template + custom editor

Developer creates `templates/promo/index.tsx`. Defines schema with
Zod. Writes the render function returning `{ html, css, js }`.
Adds custom editor at `admin/editors/promo.tsx` for fields the
default `@rjsf` form doesn't handle well. Tests in dev playground.

**Friction shapes to watch:**
- Template scaffolding — no copy-paste from another template needed
- Schema → form auto-generation works without custom editor most of
  the time
- Custom editor mounting contract — clear; framework-agnostic per
  `design-decisions.md` #12
- HMR for templates AND editors during dev — saves don't require
  page reload; preview stays current
- Type access — `@templates/promo` import works; types flow

### TD2: Debugging a template that renders wrong

Developer's template is producing unexpected HTML. Could be: schema
mismatch, content not what they expected, asset reference not
resolving, locale fallback wrong, theme variant missing.

**Friction shapes to watch:**
- Error visibility — when the template throws, the error overlay
  shows file path + line + stack
- Diagnostic data — what content was the template invoked with? what
  resolved-asset URLs? what locale + theme? Without this, debugging
  is guess-and-check
- Dev playground (`/admin/dev`) — does it expose the input data the
  template would receive in real use?
- HMR loop time — sub-second from save to preview update

**What we tend to optimize for**: working examples.
**What gets ignored**: the hour spent debugging why the example
doesn't work in YOUR site.

### TD3: Understanding why a schema migration breaks content

Developer adds a required field to an existing template's schema.
Existing content (across N pages) doesn't have the field. Renderer
errors at publish time, OR validator surfaces N issues, OR runtime
silently fills with undefined.

**Friction shapes to watch:**
- When does the breakage become visible? (Save? Publish? Render?)
- Where does it surface? (Site-health drawer per `design-validation.md`?
  CLI? Admin tree dots?)
- Migration path: does the developer have to update content
  page-by-page, or is there a bulk-update affordance?
- AI-assisted migration: future direction per `design-ai.md`'s
  "second consumer" pattern; today the developer does it by hand.

### TD4: Composing an existing template into a new fragment

Developer wants to build a `promo-grid` fragment that uses the
existing `promo` template as inline children. They reference it in
the fragment's `components` array.

**Friction shapes to watch:**
- Composition syntax — clear from existing examples, not requiring
  doc-diving
- Preview — fragment renders in isolation in the dev playground
- Naming collisions — what happens when two templates have the same
  name? (Should be impossible; clear error if encountered)
- Subfolder templates — `buttons/primary` works the same as flat
  templates per `operations.md`

---

## Operator scenarios

The person publishing content to targets and managing deployment.

### OP1: First-time deployment to a new target

Operator runs `gazetta init`. Configures a Cloudflare Pages target in
`site.config.ts` (R2 storage + worker). Sets credentials in
`.env.local`. Runs `gazetta build`. Runs `gazetta deploy production`.
Verifies the site is live.

**Friction shapes to watch:**
- Init scaffold — usable site after `init`, no manual fixup required
- Credentials documentation — clear which env vars are needed and
  where to get each one
- Build errors — when something's wrong, the error names the file +
  line + cause, not just "build failed"
- Deploy errors — credential, network, quota, permission errors
  named distinctly; remediation hints in the output
- First-publish success — the operator sees "live at https://..."
  with confidence, not just "deploy completed"

**What we tend to optimize for**: experienced-developer onboarding.
**What gets ignored**: the operator who sets this up once a year and
has forgotten the steps.

### OP2: Hotfix to production at 11pm

Operator gets paged: a typo on the homepage. Opens admin against
production target (which has `editable: true`). Edits the page. Saves
directly to production. Verifies the fix is live.

**Friction shapes to watch:**
- Production chrome — red accents make "you are editing prod" un-missable
- Save labeling — "Save to prod" not just "Save"
- Cache invalidation — happens automatically; operator doesn't have
  to remember a separate command (per `design-publishing.md`)
- Audit clarity — the operator's emergency edit is recorded with
  "edited from local at 11:47pm" so morning standup has context

### OP3: Promoting staging to production

Operator has staging tested and ready. Opens publish dialog. Source:
staging. Destination: production. Reviews items list (what's
changing). Confirms. Watches per-target progress. Verifies.

**Friction shapes to watch:**
- Diff clarity — the operator sees what's changing, not just "12
  files" (per `design-publishing.md` compare semantics)
- Confirmation — production confirmation requires explicit acknowledgment
- Progress visibility — per-page status; failed items surface clearly
- Partial-failure handling — if 11 of 12 succeed, the 1 failure is
  visible + retryable; doesn't roll back the 11

### OP4: Configuring redirect / archive lifecycle

Operator wants to rename a page (per `design-soft-delete.md`).
Selects the page in admin. Clicks Rename. Picks a new name. Confirms
that the old URL will 301-redirect. Verifies the redirect after
publish.

**Friction shapes to watch:**
- Rename action discoverability — visible without nested menus
- Modal copy — "rename" is not "delete"; alias semantics clear
- Pre-publish preview — operator sees "/old → /new (301)" before
  committing
- Capability gap — plain-static target shows "redirects won't fire
  here" warning at the four points (boot validate / author modal /
  scanner / publish gate per `design-soft-delete.md` Q10)
- Verification — after publish, hitting old URL in a browser shows
  the 301 immediately

### OP5: Reading the audit log for a forensic question

Operator gets asked: "who changed page X last week?" or "did anyone
publish to prod between 2pm and 4pm?" Opens admin audit drawer.
Filters by scope/date/actor. Reads the answer.

**Friction shapes to watch:**
- Audit drawer discoverability — visible from the top toolbar, not
  hidden in a sub-menu
- Filtering — date / actor / action / scope filters compose
- Event detail — each event shows actor + action + scope + outcome
  + metadata in plain language (not JSON-stringified)
- External-sink awareness — if audit goes to CloudWatch, the drawer
  links to the external query (per `design-audit.md` Q4 lock)
- Pseudonymization — when enabled, operators see hashed actor IDs;
  documentation explains how to de-pseudonymize if authorized

---

## CMS Developer scenarios

The person maintaining Gazetta itself (the `packages/gazetta/`,
`apps/admin/` source tree).

### CD1: Writing a new storage provider plugin

Developer wants Gazetta to talk to a backend Gazetta doesn't ship
support for (e.g., DynamoDB, GCS). They write a factory function
that returns a `StorageProvider` instance. They publish it to npm.

**Friction shapes to watch:**
- Interface clarity — `StorageProvider` contract documented + typed;
  required vs optional methods clear
- Test infrastructure — `adminCacheContractTests`-equivalent for
  storage providers (testing-plan.md Priority 3.2 future)
- Multi-instance discipline — the contract spells out what the
  provider must do for multi-instance correctness
- Integration friction — the provider plugs in via factory call (Path
  X — `design-provider-config.md`); operator imports + invokes inline
- Error taxonomy — when something goes wrong, the developer's error
  class composes with Gazetta's existing error handling

### CD2: Extending the validator suite

Developer wants to add a custom validator (e.g., "every page must
have a hero image") to a Gazetta project. They write a `Validator`
implementation. They register it in `site.config.ts`'s
`admin.validators` array.

**Friction shapes to watch:**
- `Validator` interface — narrow + clear (validate function + stages
  + severity per `design-validation.md`)
- Registration — `admin.validators: [...]` is the only step; no
  separate manifest update
- Stage semantics clear — save-delta / background / pre-publish / cli
- Error reporting — `Issue[]` shape consistent across validators;
  surfaces in the standard places (banner / drawer / publish gate)
- Test infrastructure — running the validator against fixture content
  is straightforward

### CD3: Building a hook handler for a custom integration

Developer wants to fire an external webhook on every publish (e.g.,
notifying Slack). They write a hook factory that returns a
`HookContribution`. They register it in `site.config.ts`'s
`admin.hooks` array.

**Friction shapes to watch:**
- `HookContribution` shape — clear; one factory returns one
  contribution carrying multiple `HookEntry` items
- Phase vocabulary — `beforeSave` / `afterPublish` / etc.
  documented + typed
- Hook context — `Principal`, scope, timestamp, requestId all
  available + typed
- Dispatch semantics — sync vs async behavior clear (per
  `design-hooks.md`); errors fail-open per the locked invariant
- Audit integration — hook firings show up in audit log without
  developer instrumentation

### CD4: Understanding the multi-instance discipline well enough to ship

Developer is implementing a feature that touches storage. They need
to ensure it works when admin runs across N horizontally-scaled
instances. Per `feature-design-process.md`'s "Multi-instance
discipline" non-foundational rule: state goes through shared
storage with appropriate granularity; in-process caches must be
scoped to one operation.

**Friction shapes to watch:**
- Discipline doc clarity — the rule is documented in one place
  (`feature-design-process.md`); examples cite specific patterns
  (per-edge sidecars per `sidecars.md`)
- Pattern recognition — "this is a per-edge sidecar case" vs "this
  is a per-instance memo case" is teachable from existing code
  (asset-refs, fragment-deps, archive-aliases as canonical examples)
- Failure mode visibility — when a developer accidentally creates a
  multi-instance bug, it's caught at design review time, not in
  production
- Validation — synthetic-multi-instance tests catch drift; today
  this is mostly inspection-based, not automated

---

## What this corpus does NOT cover

The scenarios above are the daily-friction shape. Several adjacent
categories of UX work happen at edges and aren't captured here:

| Category | Why excluded | Where it goes |
|---|---|---|
| First-30-minutes onboarding (cold install → first publish) | Different friction shape; better captured by an "onboarding speedrun" practice (per session retrospective) | Future `docs/onboarding-friction.md` if/when we run those speedruns |
| Power-user shortcuts (keyboard nav, multi-select) | Edge cases over the operating envelope; emerge after daily-use UX is solid | `design-scale.md` Future directions; per-feature design Future Directions |
| Migration scenarios (existing site → Gazetta) | Operator-rare; covered by `docs/migration.md` per-feature | Per-feature migration sections |
| Plugin author daily flow (CD1-3 are the "ship a plugin" cases; not the "use a plugin daily" cases) | Currently subsumed by Operator scenarios; if plugin DX becomes its own concern, split out | TBD when concrete demand surfaces |

These get their own scenario corpus when they earn one — not v1.

## Maintenance

The corpus is meant to be small and stable; pruning is harder than
adding. When a feature's UX-grilling phase identifies a missing
scenario:

1. Walk the candidate scenario in the relevant feature design pass
2. If it's recurring (3+ features would walk it), add to this doc
3. If it's feature-specific, document in the feature's design doc
   under "Author / Operator scenarios" or similar

When a scenario goes stale (the friction shape changed because the
product changed):
1. Note in the scenario block that it's superseded
2. Replace with the current friction shape; keep the older one in
   git history if the comparison helps future readers

Don't accumulate scenarios past the "useful as a yardstick" budget —
~20 is a reasonable cap. More than that and the corpus stops being
checkable in a single grilling pass.
