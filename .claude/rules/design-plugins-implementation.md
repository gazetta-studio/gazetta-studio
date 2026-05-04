---
paths:
  - "packages/gazetta/src/plugins/**"
  - "packages/gazetta/src/admin-api/**"
  - "**/site.config.ts"
---

# Plugin / extensibility — Implementation

Companion to [design-plugins.md](design-plugins.md). Cut sequence with risk ordering.

See [design-plugins.md](design-plugins.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `plugins-v1` off `main`. Sequenced after TS config + Hooks per Phase 1 dependency order. **No backwards compatibility**.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `plugins/` infrastructure: types, `Plugin` shape, `PluginAPI` interface | ☐ | Low | Type-only foundation |
| 2 | Plugin loader: walk `admin.plugins` array; serial async init; `optional()` wrapper | ☐ | Medium | The dispatch core |
| 3 | `PluginAPI` registration methods: `registerHook` + barrels for existing surfaces | ☐ | Medium | Plugin extension point |
| 4 | Provider registration: `registerStorageProvider`, `registerCacheProvider`, `registerAuditProvider`, `registerAuthIdentityProvider`, `registerAltTextAdapter`, `registerTransformAdapter`, `registerDeployAdapter`, `registerValidator` | ☐ | Medium | All 11 surfaces wired |
| 5 | Admin UI registration: `registerEditor` + `registerField` | ☐ | Low | Admin extension surfaces |
| 6 | Route registration: `registerRoute` with Zod schema + capability gate | ☐ | Medium | Plugin-contributed admin routes |
| 7 | `RegistrationAfterInitError` enforcement | ☐ | Low | Window-bounded registration |
| 8 | Versioning: peerDep load-time check with warning | ☐ | Low | Forward-compat |
| 9 | Service-account capabilities: opt-in elevation for plugin hooks | ☐ | Medium | Plugin trust elevation |
| 10 | Plugin author docs + example plugin | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: Infrastructure

**Files added:**
- `packages/gazetta/src/plugins/types.ts` — `Plugin`, `PluginAPI`, `PluginRegistration`, `PluginLogger`
- `packages/gazetta/src/plugins/errors.ts` — `PluginConfigurationError`, `RegistrationAfterInitError`
- `packages/gazetta/src/plugins/index.ts` — barrel; exports `optional` from hooks/

**Tests:** types compile

### Cut 2: Plugin loader

**Files added:**
- `packages/gazetta/src/plugins/loader.ts` — `loadPlugins(siteConfig)` walks `admin.plugins` array; calls `init(api)` for each; awaits each serially; collects `dispose()` references
- `packages/gazetta/src/plugins/api-impl.ts` — `PluginAPI` instance per plugin; tracks registration window state

**Tests:** serial init order + async init awaiting + optional plugin failure → log + continue + non-optional plugin failure → boot fails

### Cut 3: Hook registration via `PluginAPI`

**Files modified:**
- `packages/gazetta/src/plugins/api-impl.ts` — `registerHook(phase, handler, options)` delegates to hooks registry with namespace prefix (`@plugin-name:hookName`)

**Tests:** plugin-supplied hooks land in priority band 100-999 + namespacing prevents collisions

### Cut 4: Provider registration

**Files modified:**
- `packages/gazetta/src/plugins/api-impl.ts` — 8 register methods for the 8 provider-shaped surfaces
- Each register method validates the factory + adds to the surface-specific registry

**Tests:** plugin-supplied provider survives operator config selection (`provider: '@my-org/redis'` resolves to plugin's registered factory)

### Cut 5: Admin UI registration

**Files modified:**
- `packages/gazetta/src/plugins/api-impl.ts` — `registerEditor(name, mount)` + `registerField(name, mount)` extend the existing editor/field registries

**Tests:** plugin-supplied editor mounts in admin shell

### Cut 6: Route registration

**Files added:**
- `packages/gazetta/src/plugins/route-registry.ts` — `RouteDefinition` + Hono integration; one handler per (method, path) tuple; collision throws

**Files modified:**
- `packages/gazetta/src/plugins/api-impl.ts` — `registerRoute(definition)` registers Hono route with capability middleware

**Tests:** plugin-supplied route serves under `/api/plugins/{plugin-name}/...` + capability gate enforced + Zod schema validation

### Cut 7: `RegistrationAfterInitError`

**Files modified:**
- `packages/gazetta/src/plugins/api-impl.ts` — after init resolves, all register methods throw `RegistrationAfterInitError`

**Tests:** registration call after init resolves throws clearly

### Cut 8: Versioning

**Files added:**
- `packages/gazetta/src/plugins/version-check.ts` — read plugin's `package.json` peerDep on `gazetta`; semver-compare against running version; warn on mismatch (no refuse)

**Tests:** mismatch logs warning + valid range no warning + site-local plugins skip check

### Cut 9: Service-account capabilities

**Files modified:**
- `packages/gazetta/src/auth/role-resolver.ts` — when hook fires from a plugin with `serviceAccount` config, principal's caps unioned with service account's for hook duration
- `packages/gazetta/src/audit/types.ts` — extend `metadata` shape to record `serviceAccount` elevation

**Tests:** hook with `serviceAccount: ['read:audit-log']` can read audit even when triggering principal lacks the capability + audit metadata records the elevation

### Cut 10: Docs

**Files added/modified:**
- `docs/plugins.md` (NEW) — plugin author guide
- `examples/starter/admin/plugins/local-webhook/` (NEW) — example local plugin

## Validation gate (definition of done)

- [ ] All 10 cuts merged
- [ ] Existing in-tree provider implementations (R2Storage, AnthropicAltAdapter, etc.) refactored to register via the plugin API at boot — proves the contract works for all 11 surfaces from day one
- [ ] At least one example local plugin in starter

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Plugin marketplace | Out of scope; v1 plugins via npm registry directly |
| Plugin sandbox / per-plugin permission model | Out of scope; full Node access by design |
| Plugin hot-reload | v1 requires admin restart |
| Plugin discovery via `package.json` `gazetta` field | UI hint only; not load-time discovery |

## Open implementation questions

1. **Dynamic import for npm-installed plugins**: standard ESM resolution from `node_modules` works; plugin author's package.json `main` / `exports` field drives entry point.
2. **`PluginAPI` instance scope**: per-plugin instance or shared with state-track? Per-plugin, with internal state tracking init window per plugin.
3. **Existing in-tree provider refactor**: do this as part of Cut 4, OR as a separate post-Cut-9 sweep? Recommend within Cut 4 for each surface — proves the contract on real implementations early.

## Estimates

| Cut | Estimate |
|---|---|
| 1-2 | 1.5 days |
| 3-5 | 2 days |
| 6 | 1.5 days |
| 7-9 | 1.5 days |
| 10 | 1 day |

**Total: ~7-8 days.**

## SOLID checks per cut

- **Cut 1-2**: SRP per file. DIP — consumers depend on `Plugin` interface, not loader internals.
- **Cut 4**: ISP — register methods are typed per surface; each provider factory has its own type. OCP — adding a new surface is a new register method, not a refactor of existing ones.
- **Cut 6**: SRP — route registry separate from plugin loader.
- **Cut 9**: composition with auth/RBAC + audit; preserves both layers' contracts.
