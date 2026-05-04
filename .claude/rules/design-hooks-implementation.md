---
paths:
  - "packages/gazetta/src/hooks/**"
  - "packages/gazetta/src/admin-api/**"
  - "packages/gazetta/src/admin-api/routes/**"
---

# Hooks — Implementation

Companion to [design-hooks.md](design-hooks.md). Cut sequence with risk ordering, per-cut scope, deferred items.

See [design-hooks.md](design-hooks.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `hooks-v1` off `main`. Sequenced after AuthIdentity + Audit per Phase 1 dependency order. **No backwards compatibility**; existing save/publish handlers update wholesale.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `hooks/` infrastructure: types, signatures, HookContext shape | ☐ | Low | Type-only foundation |
| 2 | Hook registry + priority-based dispatch + per-hook timeout | ☐ | Medium | The dispatch core |
| 3 | Discovery: site-local `admin/hooks/` walker | ☐ | Medium | File-based discovery |
| 4 | Wire `beforeSave` / `afterSave` / `afterLoad` into save/load handlers | ☐ | Medium | First production hook integration |
| 5 | Wire `beforePublish` / `afterPublish` into publish handler | ☐ | Medium | Publish-lifecycle hooks |
| 6 | Wire `beforeUpload` / `afterUpload` into asset upload handler | ☐ | Low-medium | Asset hooks compose with existing UploadPreprocessor/Analyzer |
| 7 | Audit integration: `action: 'hook-fired'` + `outcome: 'hook-cancelled'` extensions | ☐ | Low | Composes with audit foundation |
| 8 | Review-lifecycle hook phases (10 phases per design-review-workflow.md) | ☐ | Medium | Forward-compat for review-workflow feature |
| 9 | `optional()` wrapper + plugin-supplied registration via plugin contract | ☐ | Medium | Forward-compat for plugins foundation |
| 10 | Docs + example hooks in starter | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: `hooks/` infrastructure

**Files added:**
- `packages/gazetta/src/hooks/types.ts` — `HookPhase`, `HookHandler<T>`, `HookContext`, `HookRegistration`, `HookOptions`
- `packages/gazetta/src/hooks/errors.ts` — `HookCancellation`, `HookTimeout`, `RegistrationAfterInitError`
- `packages/gazetta/src/hooks/index.ts` — barrel

**Tests:** type-level checks only

**Why first:** lowest blast radius.

### Cut 2: Hook registry + dispatch + timeout

**Files added:**
- `packages/gazetta/src/hooks/registry.ts` — `HookRegistry` with priority-sorted insertion + tie-break by registration order
- `packages/gazetta/src/hooks/dispatch.ts` — `dispatchBefore<T>(phase, payload, ctx, timeout)` chains; `dispatchAfter(phase, result, ctx)` parallel via `Promise.allSettled`
- Per-hook timeout enforcement via `Promise.race`

**Tests:** priority order + chaining + cancellation propagation + timeout enforcement + after-fire-and-forget failure isolation

**Why second:** the core. Subsequent cuts integrate against this.

### Cut 3: Discovery — site-local walker

**Files added:**
- `packages/gazetta/src/hooks/discovery.ts` — walks `admin/hooks/*.{ts,js}`; dynamic-imports each; extracts named exports (`beforeSave`, `afterPublish`, etc.) + optional `meta`; registers against the registry

**Tests:** discovery picks up all phase exports + missing files don't error + invalid exports surface clear errors

**Why now:** required before hooks can actually fire.

### Cut 4: Wire save / load handlers

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — call `dispatchBefore('beforeSave', payload, ctx)` after validation; `dispatchAfter('afterSave', result, ctx)` after storage write
- Same pattern in `fragments.ts`
- Add `dispatchAfter('afterLoad', result, ctx)` in load paths

**Tests:** integration tests for hook firing during real save → confirms order: validators → beforeSave → storage → afterSave

**Why now:** first production hook integration. Validates the dispatch in real conditions.

### Cut 5: Wire publish handler

**Files modified:**
- `packages/gazetta/src/admin-api/routes/publish.ts` — `dispatchBefore('beforePublish', items, ctx)` + `dispatchAfter('afterPublish', result, ctx)`

**Tests:** integration during publish → confirms hook chain works for multi-item publishes

**Why now:** publish is more complex than save; landing it after save patterns are stable.

### Cut 6: Wire asset upload handler

**Files modified:**
- `packages/gazetta/src/admin-api/routes/assets.ts` — `dispatchBefore('beforeUpload', { asset, bytes }, ctx)` BEFORE existing UploadPreprocessor / UploadAnalyzer pipeline; `dispatchAfter('afterUpload', result, ctx)` after manifest write

**Tests:** integration confirms hooks compose cleanly with existing preprocessor/analyzer (which run first per design-hooks.md asset-upload-note)

**Why now:** straightforward integration; benefits from save/publish patterns being established.

### Cut 7: Audit integration

**Files modified:**
- `packages/gazetta/src/audit/types.ts` — extend `action` enum with `'hook-fired'`; extend `outcome` enum with `'hook-cancelled'` + `'timeout'`
- `packages/gazetta/src/hooks/dispatch.ts` — emit audit event per hook firing with name + priority + phase + durationMs

**Tests:** dispatch emits audit events correctly; failure outcomes record correctly

**Why now:** depends on Audit foundation (Phase 1 prior).

### Cut 8: Review-lifecycle hook phases

**Files added:**
- 10 review-phase types in `packages/gazetta/src/hooks/types.ts`: `BeforeSubmitForReviewHook`, `AfterSubmitForReviewHook`, `BeforeApproveHook`, `AfterApproveHook`, `BeforeRejectHook`, `AfterRejectHook`, `BeforePublishRequestHook`, `AfterPublishRequestHook`, `BeforePublishApproveHook`, `AfterPublishApproveHook`

**Tests:** types compile; registry accepts review phases

**Why now:** types only; the actual review state machine that fires these is Phase 2 work. Forward-compat preparation.

### Cut 9: `optional()` wrapper + plugin registration

**Files added:**
- `packages/gazetta/src/hooks/optional.ts` — `optional(plugin)` returns `PluginRegistration` with `optional: true`
- `packages/gazetta/src/plugins/api.ts` — extend `PluginAPI` interface with `registerHook<TPhase>(...)` (this code lives in plugins/ but is hook-API-shaped)

**Tests:** optional plugin failure → log + continue; plugin-registered hooks land in priority band 100-999

**Why now:** depends on Plugin loader (later in Phase 1). For this cut, ship the `optional()` helper but plugin-supplied hook discovery wires up when plugins land.

### Cut 10: Docs

**Files added/modified:**
- `docs/hooks.md` (NEW) — site-local hook authoring guide + plugin-supplied hook reference + service-account capabilities forward-pointer
- `examples/starter/admin/hooks/` (NEW directory) — at least one example: `auto-slugify.ts` for blog pages
- `examples/starter/site.config.ts` — example `admin.hooks.disable` reference (deferred-config; just for forward-compat doc)

**Why last:** code is stable.

## Validation gate (definition of done)

- [ ] All 10 cuts merged
- [ ] At least one example hook exists in `examples/starter/admin/hooks/` and runs in the starter site
- [ ] Audit log records hook firings correctly (composing with audit foundation)
- [ ] Plugin loader (next foundation) integrates against `registerHook` cleanly

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Render-lifecycle hooks (`beforeRender`, `afterRender`) | Render formalization in Phase 3; render hooks reserved per design-rendering.md |
| Validation hooks | Permanently rejected (validators are pure functions per design-validation.md) |
| Audit hooks | Audit observes via the audit log itself; no hook firings |
| `beforeLoad` | Nothing to mutate yet |
| Fire-and-forget mode (`mode: 'async'`) | Concrete operator demand; v1 is sync-blocking only |
| Total operation timeout | Per-hook timeout is the cap; total cap reserved if observed pain surfaces |
| Hot-reload of hook files | Out of scope; v1 hooks require admin restart |
| Disable-by-config (`admin.hooks.disable`) | v2 ergonomic; v1 disable = delete file |

## Open implementation questions

1. **Dynamic import vs static glob**: site-local hook discovery via `import.meta.glob` (Vite) or runtime `await import()` (Node)? Recommend `await import()` for Node compatibility; Vite's glob is admin-specific.
2. **HookContext.storage as ReadOnlyStorageProvider**: implement as a Proxy filtering write methods, or a separate type? Recommend Proxy for less code duplication.
3. **Per-hook timeout default tunable per phase?** v1 ships uniform 5s default. Per-phase override deferred unless concrete operator pain surfaces.

## Estimates

| Cut | Estimate |
|---|---|
| 1 (Infrastructure) | 0.5 day |
| 2 (Registry + dispatch) | 1.5 days |
| 3 (Discovery) | 1 day |
| 4 (Wire save/load) | 1 day |
| 5 (Wire publish) | 0.5 day |
| 6 (Wire asset upload) | 0.5 day |
| 7 (Audit integration) | 0.5 day |
| 8 (Review-lifecycle phases) | 0.5 day |
| 9 (Optional + plugin) | 0.5 day |
| 10 (Docs) | 1 day |

**Total: ~7-8 days.** With CI iteration, budget ~1.5 weeks.

## SOLID checks per cut

- **Cut 1-2**: SRP per file (registry / dispatch / errors). DIP — consumers depend on `HookHandler<T>` type.
- **Cut 3**: SRP — discovery is one module; doesn't bleed into dispatch.
- **Cut 4-6**: each route handler integrates uniformly; no per-route dispatch logic. ISP — handlers see only the dispatch API.
- **Cut 7**: composition with audit; doesn't break either layer's contracts.
- **Cut 9**: `optional()` is a typed wrapper; doesn't change `Plugin` shape.
