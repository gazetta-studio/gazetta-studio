# Editor UX

How the CMS admin organizes authoring, comparison, and publishing around a single spine:
the **active target**. This doc covers UX concepts and behavior rules; see design-concepts.md
for the underlying nouns and design-publishing.md for operations.

## The active target is the UX spine

At any moment, exactly one target is active. Everything in the workspace orients around it:

| Surface | Binds to active target as |
|---------|---------------------------|
| Tree | Structure of active target |
| Editor | Form for selected item on active target |
| Preview | Rendered output of active target |
| Save | Writes to active target (if editable) |
| Publish | Defaults source or destination to active |
| Sync indicators | Other targets shown "N behind/ahead of active" |
| Compare | Framed as "active vs X" |

## Editable vs read-only

A target's `editable` flag determines what the author can do when that target is active:

| `editable` | Author can | Author cannot |
|-----------|-----------|---------------|
| `yes` | Edit form, save, receive publishes from other targets | — |
| `no` | View tree, inspect editor (read-only), view preview, publish *from* this target to others | Save, receive publishes |

The workspace chrome reflects the current state: read-only active targets lock the editor,
hide the save button, and show read-only indicators.

## Switching active target

Switching is cheap in browse mode; in edit mode with unsaved changes it triggers the
same unsaved-changes guard as any other navigation. One affordance, one place:

### Top-bar switcher (sole switcher)

**Intent:** navigate workspace focus to a different target — works equally for
"show me this page on staging" (A/B comparison) and "go edit staging next."

- Location: top bar, always visible
- Shows: active target name + environment chrome + sync indicators for other targets
- Behavior:
  - If focused item (page/fragment) exists on destination → preserve focus, swap target
  - If focused item doesn't exist on destination → focus drops to site root; transient banner:
    *"pages/pricing isn't on staging — showing site root"* with one-click "back to pages/pricing on local"
  - If the editor has unsaved edits → unsaved-changes dialog (Save / Don't Save / Cancel)
    runs before the switch, same flow as router-driven navigation. Keeps the author in
    control and prevents silent drops or writes to the wrong target.

**Why one switcher, not two:** an earlier design had a second "preview tabs" affordance
at the top of the preview pane for rapid A/B flipping. Since page selection survives
target switches, the top-bar switcher already gives rapid A/B — the second affordance
was redundant and invited accidental switches during editing. Same rationale as unified
Publish: one verb per concern.

## What's preserved across switches

Switching must not disorient the author. Preserve across active-target switches in
browse mode:

- **Preview**: scroll position, viewport size, zoom, device mode
- **Tree**: expansion state
- **Selection**: focused item + any sub-selection

In edit mode, the unsaved-changes guard runs first. On *Save* or *Don't Save* the
editor clears (as with any page-to-page navigation); on *Cancel* nothing changes.
Per-target dirty form state is not preserved — the guard makes the author's intent
explicit, and preserving parallel drafts across targets invites drift that's hard to
reason about ("which draft was I on again?").

## Making the active target unmistakable

Rapid target switching (comparison mode) requires the author to always know which target is
active without conscious thought. Design commitments:

- **Workspace chrome tinted by environment**: prod gets red accents on top bar, edges, borders.
  Local is neutral. Staging is amber. Applied to the whole workspace, not just a corner —
  peripheral vision catches it.
- **Persistent target name** in a fixed top-bar position, large enough to read without focus
- **Save button label** reflects the target: "Save to prod" when prod is active (when editable)

If the author is editing production directly (allowed by `editable: yes` on prod), the prod
chrome is permanent — no confirmation dialog, but constant visual warning.

## Item availability across targets

An item is "available" on a target if its path exists there. Availability determines:

- **Top-bar switcher menu**: targets missing the focused item still switch, but focus
  falls back to the site root with a transient banner (see "Switching active target").
- **Empty-state messaging**: when an item doesn't exist on the destination, show a publish
  affordance ("Publish pages/pricing from local to staging") rather than a raw error

The tree reflects only the active target's structure — it does not show items present on
other targets. Cross-target visibility lives in sync indicators and publish flows.

## Save and publish share a pipeline

Save and publish are architecturally the same operation — "write logical content to
destination + render if destination is static." They differ only in destination:

- **Save**: form-state → active target
- **Publish**: target → target (either direction)

From the author's POV, save is instant on dynamic targets; on static edit targets, save
incurs render cost and shows a visible "Saving…" state. Preview reflects saved state
(or dirty form state if unsaved).

**Two pending lanes, one save.** Form-state covers two kinds of edits: **content** edits
(per-component field changes) and **structural** edits (move/add/remove of components on
a page or fragment manifest). Both are pending until explicit save; both contribute to
the dirty-dot indicator; both are reverted by Discard for the focused page; save flushes
both atomically in one transaction. Authors see the tree reflect a pending reorder
immediately, but the disk file is unchanged until save lands. This avoids the asymmetry
where a discard would revert content edits while structural changes silently persisted.

## Undo and rollback

Every write records a revision on the target (see design-publishing.md for storage shape).
Two UX entry points surface the same underlying mechanism:

**Transient Undo after an action.** After a save or publish completes, the top bar briefly
shows the action + an Undo button:

> *Published 3 items to prod. [Undo]*

One click restores the target's immediately prior state (as a new revision). The Undo
affordance disappears once a newer write lands on that target — use the history panel for
arbitrary rollback after that point.

**Target history panel.** Click a target in the top bar to open its history — a list of
revisions with timestamp, author, operation, and affected items. Each row has a **Restore**
action that creates a new revision matching that past state. Rollback is just restore to
an older revision.

Undo and rollback are the same operation; they differ only in entry point. Both produce
forward-only revisions — history never shrinks except via retention eviction.

## Scaling to 4+ targets

When the total target count is ≥ 4, targets sharing an `environment` collapse into a group
across all target-referencing surfaces. Groups of 1 stay flat; targets with no environment
set display ungrouped alongside groups.

| Surface | ≤ 3 targets (flat) | 4+ targets (grouped) |
|---------|--------------------|-----------------------|
| Top-bar sync indicators | `staging · 3b   prod · 7b` | `staging · 3b   production (2) · 7b` (click → expand) |
| Top-bar switcher menu | Flat list of targets | Grouped by environment with sub-menus |
| Publish picker (From / To) | Flat dropdown | Dropdown grouped by environment with headers |

**Cycling within a group:** hovering a group in the switcher menu reveals its members;
when a group member is active, the indicator shows which: `production: prod-us`.

**Grouping is presentation only.** Environments remain non-hierarchical in the model;
grouping is a UX compression for density, not a configured concept.

## Multi-destination publish (fan-out)

The Publish picker's "To" selector supports multi-select. Selecting an environment group
selects all its members; individual members can be toggled. A single Publish action then
fans out to all selected destinations.

Progress is reported per-destination; a failure on one destination does not abort the
others. Author sees the full matrix of results.

No new operation — Publish already moves content between any two targets. Fan-out is a
picker mode on top of the same verb.

## Progressive disclosure

The UI adapts to configured targets. Features appear based on config, not user profile:

| Configuration | UI changes |
|---------------|------------|
| 1 target configured | No publish UI. Save is all. No target switcher. |
| 2+ targets | Publish affordance appears. Sync indicators in top bar. |
| 4+ targets | Environment-based grouping in sync indicators, switcher menu, and publish picker. |
| 2+ peers share an environment | Fan-out publish available (multi-select in picker). |
| 2+ targets, one tagged `production` | Prod chrome (red accents) everywhere prod is referenced. |
| 2+ targets | Active-target switcher in top bar becomes interactive. |
| Editable target tagged `production` | Prod chrome on workspace when active; "Save to prod" labeling. |
| Any target marked non-editable | That target appears read-only when active; save is absent. |

No profile selection, no settings toggles. Target configuration *is* the workflow.

## Out of sync

When two targets differ in logical content, they're "out of sync." No hierarchy is implied
— neither target is presumed correct. The author knows which is authoritative because the
author configured the workflow. UI framing:

- "staging: 3 behind local" = three items on local that staging doesn't have or differs on
- "prod: 2 ahead of local" = two items on prod that local doesn't have or differs on
  (typical of direct-to-prod hotfixes)

All sync state is expressed relative to the active target. The author picks the reference
point by choosing what's active.

## Author's mental model (one sentence)

> I have one or more targets. One is active — that's where I'm focused: its tree, its editor,
> its preview. If it's editable, I can save to it. I can switch focus to any other target at
> any time, instantly, without losing my place. Publish moves content from one target to
> another, in any direction.

## Current code alignment

The design above is forward-looking. Current code state:

- **Active target** — implemented as `useActiveTargetStore`
  ([apps/admin/src/client/stores/activeTarget.ts](../../apps/admin/src/client/stores/activeTarget.ts)).
  Drives tree, editor, preview, and publish defaults. Persists to localStorage.
- **Top-bar switcher** — `ActiveTargetIndicator.vue` shows the active target pill with
  environment chrome; clicking reveals the switcher menu when 2+ targets exist. Guards
  on unsaved edits via `useUnsavedGuardStore`.
- **Sync indicators** — `SyncIndicators.vue` + `useSyncStatusStore` show "staging · 3 behind"
  chips in the top bar, relative to active. Click opens PublishPanel pre-pointed at that
  destination.
- **Target properties** — `environment`, `type`, and `editable` are all on `TargetConfig`
  ([packages/gazetta/src/types.ts](../../packages/gazetta/src/types.ts)). Defaults:
  environment=local, editable=true for local else false.
- **Unified Publish** — `PublishPanel.vue` is the sole surface. Source picker +
  destinations fan-out + item list with diffs + streaming progress + prod confirmation.
  Replaced the old PublishDialog / FetchDialog / ChangesDrawer trio.
- **Preview target switching** — driven by the top-bar switcher. Iframe morphs content
  in place (scroll/zoom preserved) when the active target changes on the same page.
  There is no page-context preview-tabs affordance — see "Why one switcher" above.
- **Fragment preview** — via `/@{name}` routing in
  [apps/admin/src/client/utils/selection.ts](../../apps/admin/src/client/utils/selection.ts).
- **Fragment blast radius** — implemented in PublishPanel item rows, editor header, and
  site tree (compact count badge). Fetches via `/api/dependents`; the admin-api's source
  sidecar writer memoizes backfill so concurrent tree badges share one pass.
- **Undo / rollback / revision history** — not implemented. Designed: per-target history in
  `.gazetta/history/` inside the target, content-addressed blobs, soft undo (forward-only
  revisions). See design-publishing.md "History" section.

## Open spots (not yet designed)

- **Multi-author** — concurrent editing, locks, handoffs
- **Batches / named releases** — grouping changes into a publishable unit
- **Scheduled publishes** — delayed or time-triggered publish
- **Permissions / roles / authentication** — per-user capabilities
- **Split-preview comparison** — side-by-side view of two targets for the same page
- **Target configuration surface** — where targets are declared (YAML file vs in-CMS settings)
- **Splitting `editable`** — potentially into `writable` (form-edit) and `publishable` (receive publishes)
  if teams need "publish to prod, but don't edit it directly"
- **Overwrite warning** — when publishing would replace newer content on the destination
