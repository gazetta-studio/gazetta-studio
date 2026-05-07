/**
 * `HookContribution` — what a hook factory returns.
 *
 * Operators add factory contributions to `site.config.ts`'s
 * `admin.hooks` array; the boot path calls each contribution's
 * `hooks[]` entries against the same registry that picks up
 * site-local file discovery.
 *
 * Per design-hooks.md Cut 9 + grilling-with-docs locked Q1
 * (bundled-object shape):
 *
 *   - `source` is package-level metadata (e.g.,
 *     '@example/cdn-purge'). Captured once per contribution; the
 *     loader stamps it on every registered HookEntry's source
 *     field for audit + diagnostics.
 *   - `hooks` is an array because one package may contribute
 *     multiple handlers across phases (e.g., a CDN-purge plugin
 *     wires both afterSave and afterPublish).
 *
 * # Why bundle vs. flat array
 *
 *   - SRP: source is per-package; hook entries are per-handler.
 *     Bundling reflects the ontology — one factory call = one
 *     logical plugin contributing N handlers.
 *   - DRY: source declared once per package, not stamped on
 *     every entry.
 *
 * # Why source is required
 *
 *   - Audit log records source per firing; defaulting to
 *     'site-local' would lie when the contribution actually came
 *     from a named package.
 *   - Plugin authors writing distributables always know their
 *     package name; declaring it is one line.
 *   - Site-local hooks (admin/hooks/*.ts) get 'site-local' from
 *     the file walker, not from this type.
 *
 * # Why duplicate sources allowed
 *
 *   - Operators legitimately invoke the same factory twice with
 *     different config (e.g., two CDN-purge instances for
 *     different regions). Both register; audit log records both
 *     events with the same source. Per-handler `options.name`
 *     distinguishes them where needed.
 *   - Locked grilling-with-docs Q5.
 *
 * # SOLID lenses
 *
 *   - SRP: type owns the contribution shape; doesn't construct
 *     handlers, doesn't register against the registry.
 *   - LSP: every plugin's factory returns `HookContribution`;
 *     the loader treats them all uniformly.
 */
import type { HookHandler, HookOptions, HookPhase } from './types.js'

/**
 * One entry in a contribution's `hooks` array. Carries the phase,
 * the handler, and per-handler options (priority / name /
 * timeout).
 *
 * `source` is intentionally absent — it lives on the parent
 * `HookContribution` and gets stamped at registration time.
 * Per-entry override would defeat the bundling rationale.
 */
export interface HookEntry {
  readonly phase: HookPhase
  readonly handler: HookHandler
  readonly options?: HookOptions
}

/**
 * What a hook factory returns. Operators add to
 * `site.config.ts`'s `admin.hooks` array; one entry per factory
 * invocation.
 */
export interface HookContribution {
  /**
   * Source identity for diagnostics + audit. Conventional values:
   *
   *   - `'@scope/package-name'` — npm-distributed plugin
   *   - `'github.com/org/repo'` — git-distributed plugin
   *   - any other unambiguous string the plugin author prefers
   *
   * The reserved value `'site-local'` is auto-applied by the
   * file-discovery walker (admin/hooks/*.ts) and SHOULD NOT be
   * used by factory-supplied contributions.
   */
  readonly source: string
  /** One or more handlers contributed by this package. */
  readonly hooks: ReadonlyArray<HookEntry>
}
