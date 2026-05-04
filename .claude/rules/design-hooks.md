---
paths:
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "packages/gazetta/src/admin-api/routes/assets.ts"
  - "packages/gazetta/src/admin-api/routes/publish.ts"
  - "packages/gazetta/src/renderer.ts"
  - "**/hook*"
---

# Hooks — design pass pending

Foundational dimension #5 of 8. Extension surface for save/publish/load/render lifecycles. Auto-slugify, auto-tag, validate against external API, enrich content at save time, transform at render time.

**Status**: design pass pending — sequenced 7 of 8 (after `design-rbac-audit-review.md` so hooks can carry actor context). See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Hook check** every new primitive design must answer
- [`design-rbac-audit-review.md`](design-rbac-audit-review.md) — hook payload includes actor identity (which requires RBAC settled first)
- [`design-plugins.md`](design-plugins.md) — hooks are an extension surface; plugin contract specifies how they're discovered + composed

**Reference**: [Payload Hooks](https://payloadcms.com/docs/hooks/overview).

## Why this is foundational

Hooks are foundational because every save / publish / load / render operation could fire hooks. Designing late means every primitive becomes hookable retroactively. That's structural rework on every consumer.

Audit category #2 from the CMS feature audit. Template Developer pain point.

## Locked invariants (already decided)

- **Hooks compose with audit log.** A hook firing is an audit-loggable event (recorded actor, target, payload, result).
- **Hooks compose with RBAC.** Hook handlers receive actor identity; can authorize against role.
- **Hooks compose with the plugin contract.** Plugins are discovered and loaded per `design-plugins.md`; hooks are one of the things plugins can register.

## Open questions for the design pass

### Multi-instance check
- Hook handlers run on whichever admin instance receives the save/publish request. No cross-instance ordering or coordination required — the writing instance fires its own hooks against its own request.
- Async hooks (fire-and-forget) — must complete on the instance that received the request, OR offload to a job queue (out of v1 scope). Cross-instance async hook scheduling is forbidden in v1.
- Hook state — hook handlers MUST NOT keep state between firings within a process (that state would diverge across instances). State that needs to persist goes through storage like any other write.
- Plugin-supplied hooks (per `design-plugins.md`) inherit these rules.

### Lifecycle phases that fire hooks
- Save — `beforeSave`, `afterSave`?
- Publish — `beforePublish`, `afterPublish`, `onPublishSuccess`, `onPublishFailure`?
- Load — `afterLoad` for content transformation on read?
- Render — `beforeRender`, `afterRender` for output transformation? (Composes with render-pipeline modes per `design-rendering.md`)
- Asset — `beforeUpload`, `afterUpload`, `beforeTransform`?
- Validation — hooks at each validation phase?

### Hook contract shape
- Synchronous (can fail/cancel the operation) vs. async (fire-and-forget)?
- Both? Different lifecycle phases imply different shapes
- Payload structure — frozen? Mutable?
- Return value — modified payload? Cancel signal? Both?

### Composition
- Multiple hooks for the same phase — order? Per-plugin priority?
- Hook conflict resolution — first-wins? Last-wins? All apply?
- Cross-cutting (hooks that fire on multiple phases) vs. single-phase hooks

### Where do hook handlers live?
- npm packages (per plugin contract)?
- Site-local in `admin/hooks/`? `sites/{name}/hooks/`?
- Both?

### Performance
- Hook overhead per save / publish — measurable cap?
- Async hooks — do they block the response or run in background?
- Hook failure — does it fail the operation or log and continue?

### Composition with each other dimension
- Hooks + RBAC — hook payload carries actor; hook gates by role
- Hooks + audit — hook firings recorded
- Hooks + scale — N hooks at scale; performance budget
- Hooks + render — render-time hooks for output transformation
- Hooks + validation — hooks fire validators, or validators fire as hooks?

## Migration

Sites without hooks configured continue to work — hook system is opt-in. Adding hooks doesn't change existing primitive shape; hooks are observers/transformers on top.

## Future directions

- Visual hook editor in admin UI — operator configures hooks without code
- Hook marketplace — npm package discovery for common patterns (slug, SEO defaults, etc.)
- Cross-site hooks (hooks that fire on multiple sites in a multi-site project) — out of scope for v1
