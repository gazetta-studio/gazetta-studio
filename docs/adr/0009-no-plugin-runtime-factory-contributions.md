# No plugin runtime; factory contributions only

> Full design + per-surface contribution shapes + foundational checks live in [`.claude/rules/design-plugins.md`](../../.claude/rules/design-plugins.md). This ADR captures the load-bearing decision; the design doc captures everything else. Supersedes the runtime-framing of [ADR-0004](0004-pluggable-provider-pattern.md) (operator-facing shape was already superseded by [ADR-0008](0008-provider-factory-returns-instance.md); this ADR removes the remaining "Plugin foundation provides discovery + loading + composition rules" framing).

There is no `Plugin` runtime contract, no `PluginAPI` god-object, no `init(api)` lifecycle, no `dispose()`. Operators install npm packages; package authors export factory functions; operators import each factory and invoke it inline in `site.config.ts`. Each factory returns a contribution to a typed array under `admin.{surface}` (`admin.hooks`, `admin.validators`, `admin.routes`) OR returns a constructed Provider instance assigned at the relevant field (`storage:`, `cache:`, etc., per ADR-0008). Multi-concern packages export multiple named factories.

```ts
// Operator imports per-surface factories and invokes them at the right array
import autoSlugify from './admin/hooks/auto-slugify'
import { slackHook, slackRoute } from '@example/slack-notify'
import linkChecker from '@example/link-checker'

export default defineSite({
  admin: {
    hooks:      [autoSlugify(), slackHook({ webhookUrl })],
    validators: [linkChecker({ excludePatterns: [...] })],
    routes:     [slackRoute({ webhookUrl })],
  },
})
```

We picked factory-contributions-only over (a) the locked plugin design (Plugin + PluginAPI + init + dispose with eleven register methods) and (b) a narrow runtime preserving init lifecycle for validators + routes only because Path X (ADR-0008) collapsed six of the eleven extension surfaces into factory-call-at-field, and Hooks Cut 9 collapsed `registerHook` into `admin.hooks` factory contributions. With those two cutovers shipped, the remaining surfaces (validators, routes, custom editors/fields, templates) are either already file-discovery (editors, fields, templates) or trivially fit the factory-contribution pattern (validators, routes). Walking the locked Q2 init-phase use cases (credential validation, capability discovery, state pre-loading, schema fetching, lazy connection setup) produced no surviving need: every one resolves to either factory-throws-at-construction or first-method-call. The `init(api)` lifecycle has no work left to do.

We picked the most aggressive simplification (factory contributions for everything) over the narrow runtime (a `Plugin` interface that registers only validators + routes) because preserving a runtime for two surfaces creates an asymmetry — six surfaces use factory-call-at-field, hooks use factory-contributions in an array, but validators + routes use a runtime registry. Operators learn three patterns instead of one. Collapsing all three to the same shape (factory contributions in typed arrays for validators + routes; factory-call-at-field for providers; already-shipped factory contributions for hooks) gives one operator-facing pattern across every extension surface.

We picked typed per-surface arrays over a single `admin.contributions: Contribution[]` discriminated array because per-surface arrays preserve sharper TS inference (each array element typed to its surface's contribution shape; autocomplete works), admit that surfaces have independent runtime semantics (hooks compose by priority; validators auto-run; routes mount as Hono handlers), and keep multi-concern packages clean (one factory per surface, one return type per factory).

## Consequences

The locked plugin design (`design-plugins.md` pre-2026-05) is rewritten. The `Plugin` interface, `PluginAPI`, `init(api)`, `dispose()`, `RegistrationAfterInitError`, and the eleven register methods are gone. They were never implemented — only documented in shipped code as JSDoc references to the locked design's intent. Removing them is a documentation-only change.

Five contribution shapes exist across the extension surfaces:

- **Provider instances** (Storage, Transform, Cache, AI, AuthIdentity, Audit, future Notification / Deploy) — per ADR-0008 + `design-provider-config.md`. Operator writes `field: factory({...})`; field type is the runtime interface.
- **`HookContribution`** (per `design-hooks.md`) — `{ source, hooks: HookEntry[] }`; lives in `admin.hooks`. Already shipped.
- **`Validator`** (per `design-validation.md`) — extended with a required `source: string` field (added in this design pass); lives in `admin.validators`. The `Validator` shape is the contribution; no wrapper.
- **`RouteContribution`** — `{ source, method, path, capability, schema, handler }`; lives in `admin.routes`. Auto-prefixed under `/api/plugins/{source}/`. Required Zod `schema` per the existing MCP discipline.
- **Custom editors / fields / templates** — file-based discovery (per `custom-editors.md`); operator places `.tsx` files in `admin/editors/`, `admin/fields/`, `templates/`. No contribution shape; the file IS the contribution.

The eight Universal Provider Requirements from ADR-0004 (multi-instance correctness, env-var credentials, fail-mode declared, never-throw-on-transport-errors at recording layer, stable typed contract, independent error taxonomy, sensible defaults, stateless interface) are preserved unchanged. They describe Provider internals and apply per-surface; the runtime framing that wrapped them in ADR-0004 is gone, but the requirements live on.

`source` is universal across contribution shapes that produce diagnostic / audit identity (`HookContribution.source`, `Validator.source`, `RouteContribution.source`). Convention: `'@scope/package'` for npm packages, `'site-local:{name}'` for operator-authored factories. Audit log records `source` as a separate metadata field alongside the per-handler / per-route name (`metadata.source` + `metadata.hookName` for hooks; `metadata.source` + `metadata.routePath` for routes). Forensic queries filter on either field.

Service-account capability elevation is a `serviceAccount?: readonly Capability[]` field on contribution shapes that fire with a `Principal` (`HookContribution`, future review-transition contributions). Plugin authors declare what their factory needs; operators approve the elevation by leaving it in / removing it from the factory call's options. Audit records the elevation in `metadata.serviceAccount`. The `withServiceAccount` operator-side wrapper rejected — declarations live with the package author who knows what their code does.

`optional()` is a lazy wrapper: `optional(() => factory(...))`. Loader evaluates the inner expression in a try/catch; on factory throw, logs structured failure (factory source, error category) and skips the contribution. Direct factory calls fail boot on throw — that's the default. The lazy form (`() =>`) is required because by the time `optional(factory(...))` is called, the inner factory has already evaluated; lazy thunks let `optional()` control when the work happens.

Contribution `requires` advisory metadata (network, capabilities, hooks) — listed in the locked design as v1.5+ ergonomic — is dropped from v1 entirely. Plugin documentation lives in npm package READMEs (universal pattern). When admin UI surfaces a "plugin inventory" view (post-v1), metadata lands as the npm `package.json gazetta` field rather than as contribution-shape fields.

Multi-concern packages export multiple named factories (`slackHook`, `slackRoute`, `slackValidator`, `slackStorage`, etc.). Shared config flows through a higher-order factory closure when multiple inner factories need the same value: `slackNotify({ webhookUrl })` returns `{ slackHook, slackRoute }` for the operator to import inner factories. One factory per surface contribution; one return type per factory; one extension surface targeted per call.

Trust posture preserved from the locked design: plugins run with full Node access; no sandbox; supply-chain attacks are operator's responsibility (audit dependencies, pin versions, install only from trusted sources). Documented in `docs/plugins.md` (when the user-facing operator guide ships).

The `Plugin` term in `CONTEXT.md` is redefined: an npm package distributing one or more factory functions that return contributions. No runtime shape; no `Plugin` interface; the term names the distribution unit, not a programmatic contract. The `Extension surface` entry is updated to remove implications that plugins "implement" surfaces — they contribute to them via factories.

Multi-instance discipline holds: contribution arrays are static config; same across instances. Each instance evaluates `site.config.ts`, builds the same contributions, registers them against per-instance registries. No cross-instance coordination of plugin state. This is structurally simpler than the locked design's `init(api)` model, where init failures had to be per-instance independent.

ADR-0004 is now superseded in two stages: ADR-0008 superseded the operator-facing config-shape consequence; this ADR-0009 supersedes the runtime-framing consequence. The eight Universal Provider Requirements survive both supersessions.

Implementation: this design pass ships as a single docs-only PR. The hook audit `source` field locked in this pass was already implemented in hooks v1 Cuts 7+9 — making the contract durable, not a code change. Per-surface implementation work lands as those surfaces ship — `admin.validators` with validation Cut 1; service-account elevation with auth/RBAC's service-account primitive; `admin.routes` standalone when first concrete demand surfaces; nothing forces a "plugins implementation" PR cluster.
