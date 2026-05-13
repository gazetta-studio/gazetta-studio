/**
 * Runtime capability inspection for a configured target.
 *
 * Per `feature-design-process.md` non-foundational disciplines
 * ("Capability-gap UX surfaced at four points") and
 * `design-soft-delete.md` Q10 capability-gap principle: when a feature
 * needs a runtime capability that some configured targets can't
 * provide (archive needing redirects on a worker; future presence
 * needing a persistent connection; future RBAC content filtering
 * needing per-request rendering), the gap surfaces at four uniform
 * places: (1) boot config validate, (2) author-time modal,
 * (3) validator scanner, (4) pre-publish gate.
 *
 * This module is the shared primitive — pure predicates over a
 * `TargetConfig`. Each of the four surfaces consumes the same answer
 * so authors and operators see consistent gap reporting regardless
 * of which surface they're looking at.
 *
 * # The capability vocabulary (closed enum)
 *
 * Future capabilities (presence, RBAC content filtering, dynamic
 * fragments) extend the enum. Each new entry pairs with one or more
 * features that need it; the inspector grows additively without
 * existing call-sites changing.
 *
 * # SOLID
 *
 *   - SRP: one file, pure predicates. No I/O, no side effects.
 *   - OCP: capability enum extends; existing call sites stay unchanged
 *     (they ask "do you have X?" not "are you platform Y?").
 *   - DIP: callers depend on the abstract `RuntimeCapability` enum +
 *     `inspectTarget()` function, not on platform discrimination.
 */
import type { TargetConfig } from '../types.js'

/**
 * Closed enum of runtime capabilities. Extend for new features that
 * need capability-gap UX (presence, RBAC content filtering, dynamic
 * fragments, etc.).
 */
export type RuntimeCapability =
  /** Worker reads HTML markers and emits `301 → aliasOf` for archived items. */
  | 'redirects'
  /** Worker emits `410 Gone` for archived-no-alias items. */
  | 'gone-status'

/** Reason a capability is missing — surfaces in audit + author UI. */
export interface CapabilityGap {
  capability: RuntimeCapability
  /** Human-readable reason; surfaces in author modals + audit logs. */
  reason: string
}

export interface TargetCapabilities {
  /** Capabilities the target supports. */
  has: ReadonlySet<RuntimeCapability>
  /** Per-missing-capability reasons for the four surfaces. */
  gaps: readonly CapabilityGap[]
}

/**
 * Inspect a target's runtime capabilities. Plain-static targets
 * (no worker, no `_redirects` host glue) lack `redirects` and
 * `gone-status`; everything else has both.
 *
 * The plain-static heuristic matches the existing P4 validator
 * (`archive-not-supported-on-target`): `type === 'static'` AND no
 * `redirects.format` configured (or `'none'`) means the host has
 * no mechanism to emit 301/410 for archived URLs.
 *
 * Worker-served target types (`dynamic` + `static-with-worker`)
 * support both capabilities natively. Static targets WITH
 * `redirects.format` ('cloudflare' | 'netlify' | 'json') support
 * `redirects` via the host's `_redirects` file, but plain-static
 * with no host config can't emit `Gone` status — the host's
 * natural 404 is the floor.
 */
export function inspectTarget(target: TargetConfig): TargetCapabilities {
  const has = new Set<RuntimeCapability>()
  const gaps: CapabilityGap[] = []

  const redirectsFormat = target.redirects?.format
  const isPlainStatic = target.type === 'static' && (redirectsFormat === undefined || redirectsFormat === 'none')
  // Worker presence detected via:
  //   - `type: 'dynamic'` (ESI mode runs on a worker), OR
  //   - a WorkerCapableDeployAdapter (e.g., cloudflareWorkersDeploy)
  // Pure-static deploy adapters (GitHub Pages, S3 static, etc.) don't
  // bundle a worker and don't implement workerRuntimeConfig().
  const hasWorker = target.type === 'dynamic' || (target.deploy !== undefined && 'workerRuntimeConfig' in target.deploy)
  const hasHostRedirects = redirectsFormat !== undefined && redirectsFormat !== 'none'

  if (hasWorker || hasHostRedirects) {
    has.add('redirects')
  } else {
    gaps.push({
      capability: 'redirects',
      reason: isPlainStatic
        ? "plain-static target has no worker and no `redirects.format` configured; archived URLs return the host's natural 404 instead of a 301 redirect"
        : 'target lacks a runtime that can emit 301 redirects',
    })
  }

  if (hasWorker) {
    has.add('gone-status')
  } else {
    gaps.push({
      capability: 'gone-status',
      reason:
        "no worker runtime available to emit `410 Gone` for archived-no-alias items; falls back to the host's natural 404",
    })
  }

  return { has, gaps }
}

/** Convenience predicate — boolean answer to "can this target serve 301 redirects?" */
export function canServeRedirects(target: TargetConfig): boolean {
  return inspectTarget(target).has.has('redirects')
}

/** Convenience predicate — boolean answer to "can this target serve 410 Gone?" */
export function canServeGoneStatus(target: TargetConfig): boolean {
  return inspectTarget(target).has.has('gone-status')
}
