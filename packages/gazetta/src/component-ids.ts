/**
 * Component IDs — stable identifiers for InlineComponent entries
 * within page and fragment manifests.
 *
 * # Why this exists
 *
 * Inline anchors (per `design-collaboration.md`) need a stable
 * reference to a specific component within a page/fragment that
 * survives reorders, edits, and template switches. The component's
 * `name` field is author-meaningful and not unique site-wide; the
 * tree path is unstable across reorders. A dedicated `id` field is
 * the load-bearing primitive for:
 *
 *   - Inline comments anchored to a component
 *   - Per-field overlays in i18n (when #192 lands; per-component
 *     overrides need a stable component reference)
 *   - Future use cases that need "this exact component, not a
 *     name-collision-prone or order-dependent reference"
 *
 * # When IDs are assigned
 *
 * On save: every InlineComponent without an `id` gets one. Existing
 * IDs are preserved across saves. Fragment-reference strings
 * (`"@header"`) don't get IDs — they reference a separate manifest
 * with its own components.
 *
 * # Why NanoID over UUID
 *
 * NanoID is 21 chars vs UUID's 36; both have collision-resistance
 * well past the operating envelope (5000 pages × 50 components =
 * 250K IDs; NanoID's 21-char alphabet of 64 symbols gives ~10^36
 * keyspace — birthday-bound nowhere near our scale). Component IDs
 * appear in audit metadata, comment payloads, and (future) persisted
 * edits — shorter is friendlier to humans skimming logs.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns ID generation + recursive injection
 *     into a manifest's components tree. Doesn't read or write
 *     storage; pure transformations.
 *   - DIP: the ID generator is injectable so tests can pass a
 *     deterministic stub. Production uses NanoID.
 */
import { nanoid } from 'nanoid'
import type { ComponentEntry, InlineComponent } from './types.js'

/**
 * The shape NanoID produces with the default 21-char length. Exposed
 * as a string type alias so call sites read cleanly without coupling
 * to the underlying generator's specifics.
 */
export type ComponentId = string

/**
 * Generator function — `() => ComponentId`. Default implementation
 * is `nanoid()`; tests inject deterministic counters.
 */
export type ComponentIdGenerator = () => ComponentId

/** Default generator — 21-char NanoID. */
const defaultComponentIdGenerator: ComponentIdGenerator = () => nanoid()

/**
 * Walk a `components` array and inject IDs on any InlineComponent
 * that lacks one. Existing IDs are preserved; fragment-reference
 * strings pass through unchanged.
 *
 * Returns a new array (functional, never mutates input). Components
 * with nested `components` recurse; the same generator instance is
 * threaded so deterministic stubs in tests produce predictable trees.
 */
export function ensureComponentIds(
  components: readonly ComponentEntry[] | undefined,
  generate: ComponentIdGenerator = defaultComponentIdGenerator,
): ComponentEntry[] {
  if (!components) return []
  return components.map(entry => ensureEntry(entry, generate))
}

function ensureEntry(entry: ComponentEntry, generate: ComponentIdGenerator): ComponentEntry {
  // Fragment refs pass through — they point at a separate manifest
  // whose components carry their own IDs.
  if (typeof entry === 'string') return entry
  return ensureInline(entry, generate)
}

function ensureInline(component: InlineComponent, generate: ComponentIdGenerator): InlineComponent {
  const nextChildren = component.components ? component.components.map(c => ensureEntry(c, generate)) : undefined
  const id = component.id ?? generate()
  // Only build a new object when something would actually change —
  // either a missing id, or recursion changed a nested entry. Keeps
  // identity-equality stable for callers that compare by reference.
  const idChanged = component.id === undefined
  const childrenChanged = nextChildren !== component.components
  if (!idChanged && !childrenChanged) return component
  const next: InlineComponent = { ...component, id }
  if (nextChildren !== undefined) next.components = nextChildren
  return next
}
