/**
 * Rewrite every reference to an asset inside one manifest, returning a
 * new deeply-cloned manifest with the refs updated. Pure (no I/O); the
 * caller decides what to do with the result.
 *
 * Two consumers:
 *   - `replace.ts` — the orchestrator for "replace asset A with asset B
 *     across the whole site" uses this to transform each referencing
 *     manifest before writing it back.
 *   - Future rename operation — same semantic (rewrite asset-name refs),
 *     just different caller intent.
 *
 * Pairs with `scan-manifest-for-asset.ts`: scan emits locations where
 * refs live; rewrite produces a new manifest with those locations
 * updated. Keeping them separate modules is deliberate SRP — scanning
 * is read-only, rewriting mutates (a copy of) the tree.
 *
 * Per-reference override semantics:
 *   When we rewrite `{ _asset: "hero", alt: "..." }` → target `banner`,
 *   we preserve the override fields (`alt`, `focalPoint`, etc.). The
 *   author's per-reference override is authored-intent, not asset-intent;
 *   it stays when the underlying asset changes. Design-media.md: "Preserve
 *   per-reference overrides when the author re-picks."
 */
import type { ComponentEntry, ComponentManifest } from '../types.js'

export interface RewriteInput {
  readonly manifest: ComponentManifest
  readonly fromAssetName: string
  readonly toAssetName: string
}

export interface RewriteResult {
  /** The new manifest with refs rewritten. Structurally cloned, so
   *  callers can freely mutate or serialize without affecting the input. */
  readonly manifest: ComponentManifest
  /** How many `{ _asset: fromAssetName }` references were rewritten.
   *  Zero is a valid result (manifest didn't reference the asset). */
  readonly rewriteCount: number
}

/**
 * Rewrite every `{ _asset: fromAssetName }` ref in `manifest` to point
 * at `toAssetName` instead. Returns a deep clone — input is untouched.
 */
export function rewriteManifestAssetRef(input: RewriteInput): RewriteResult {
  // Deep clone so the walker can mutate freely. JSON round-trip is safe
  // for manifests — they're JSON already (content is Record<string,
  // unknown> with JSON-serializable values per the schema).
  const cloned = JSON.parse(JSON.stringify(input.manifest)) as ComponentManifest
  const counter = { n: 0 }
  walkComponent(cloned, input.fromAssetName, input.toAssetName, counter)
  return { manifest: cloned, rewriteCount: counter.n }
}

/** Walk a component (page/fragment manifest or inline child). */
function walkComponent(
  comp: { content?: Record<string, unknown>; components?: ComponentEntry[]; name?: string },
  from: string,
  to: string,
  counter: { n: number },
): void {
  if (comp.content) rewriteValue(comp.content, from, to, counter)
  if (comp.components) {
    for (const child of comp.components) {
      if (typeof child === 'string') continue
      walkComponent(child, from, to, counter)
    }
  }
}

/**
 * Recursively walk a value looking for `{ _asset: from, ... }` objects.
 * When found, update `_asset` to `to` and count. Does NOT early-return —
 * a ref object can itself contain nested refs (e.g. a future composite
 * template puts one asset ref inside another's override fields).
 */
function rewriteValue(value: unknown, from: string, to: string, counter: { n: number }): void {
  if (value === null || typeof value !== 'object') return

  if (Array.isArray(value)) {
    for (const item of value) rewriteValue(item, from, to, counter)
    return
  }

  const obj = value as Record<string, unknown>
  if (typeof obj._asset === 'string' && obj._asset === from) {
    obj._asset = to
    counter.n++
  }

  for (const [key, child] of Object.entries(obj)) {
    if (key === '_asset') continue
    rewriteValue(child, from, to, counter)
  }
}
