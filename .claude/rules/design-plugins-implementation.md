---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "**/site.config.ts"
---

# Plugins — Implementation

> **Superseded by [ADR-0009](../../docs/adr/0009-no-plugin-runtime-factory-contributions.md).** The locked plugin design (Plugin runtime + PluginAPI + init/dispose + 11 register methods) is replaced with factory contributions. Implementation runway shrinks accordingly: most "plugin work" is per-surface integration as those surfaces ship. There is no standalone "plugins implementation" PR cluster.

See [`design-plugins.md`](design-plugins.md) for the design itself.

## Per-surface integration plan

| Concern | Where it ships |
|---|---|
| Provider factory-call surfaces (Storage, Cache, Transform, AI, Audit, AuthIdentity) | ✓/◐ Path X (per `design-provider-config-implementation.md`) |
| `admin.hooks` factory contributions | ✓ Hooks v1 (Cut 9) |
| Hook audit `source` separate field | ✓ Already shipped (hooks v1 Cut 7 + Cut 9 — `metadata.source` separate from `metadata.hookName`); locked as the design here so the contract is durable |
| `admin.validators: Validator[]` config + registry merge | ☐ Validation Cut 1 + 2 — `Validator.source` field added there |
| Service-account capability elevation on `HookContribution` | ☐ Auth/RBAC's service-account primitive (per `design-auth-rbac-implementation.md`) |
| `admin.routes: RouteContribution[]` config + Hono mount | ☐ Standalone — lands when first concrete demand surfaces |
| `optional()` lazy wrapper | ☐ Standalone — lands when first concrete demand surfaces |

## Hook audit `source` field (already shipped)

Locked in Q8 of the plugins grilling: audit metadata records `source` separate from `hookName` (no composed `'@scope/pkg:hookName'` string). When the grilling lock landed, the implementation was already correct:

- `packages/gazetta/src/hooks/audit-emitter.ts` — `eventFromRegistration()` reads `source` from `HookRegistration` and surfaces it on `HookFiringEvent`
- `packages/gazetta/src/admin-api/hook-audit-emitter.ts` — `makeAuditFiringEmitter` forwards both fields to `metadata.source` + `metadata.hookName`
- `tests/hooks-audit.test.ts` — already asserts `metadata.source === 'site-local'`

No code change needed in this design pass. The lock makes the contract durable so future audit consumers can rely on the shape.

## Lessons learned (from the locked design)

- **Foundational dimensions can over-shoot when designed before adjacent foundations land.** The locked plugin design predated Path X (ADR-0008) and Hooks Cut 9. Both shipped in shapes that mooted the runtime — but the locked design was already documented as if those simplifications hadn't happened. Lesson: when a foundational dimension ships before its adjacent dimensions, mark assumptions about adjacent dimensions explicitly so future cleanup is mechanical.
- **The `init(api)` lifecycle had no surviving use case.** Walking the locked Q2 use cases (credential validation, capability discovery, state pre-loading, schema fetching, lazy connection setup) every one resolved to factory-throws-at-construction or first-method-call. The `init` phase wasn't doing real work. Lesson: design lifecycles only when concrete work needs the lifetime; don't reserve them speculatively.
- **God-object register methods don't earn their keep when the registered shape is already typed at the operator-config layer.** The locked `PluginAPI` had eleven methods; under ADR-0008 + ADR-0009 they collapse to typed config fields + typed arrays. Lesson: per-ISP, prefer surface-specific extension shapes over a unified extension API.

## Deferred items

| Item | Trigger to revisit |
|---|---|
| `optional()` lazy wrapper | Concrete operator demand for "plugin might fail at boot, that's OK" |
| `admin.routes` plumbing | Concrete operator demand for plugin-supplied admin-API routes |
| Plugin-author docs (operator-facing `docs/plugins.md`) | First plugin author writing a guide; or post-1.0 operator-facing UX work |
| Admin UI plugin inventory | Operator demand for "what plugins are installed?" view |
| `package.json gazetta` field convention | Lands with admin UI inventory |
| Plugin hot-reload | v2 ergonomic |
| Plugin marketplace | v2+ |
