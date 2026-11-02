/**
 * Template impact analysis (Validation Cut 6).
 *
 * Walks the loaded site to find every page + fragment that uses a given
 * template — top-level (manifest.template === templateName) AND nested
 * inline components (recursively). Pairs with the scanner store's
 * `issuesFor(itemPath)` to project the per-template impact view that
 * the DevPlayground "Impact" tab + the toolbar banner consume.
 *
 * Surface shape matches what `GET /api/templates/:name/impact` returns:
 * a flat list of items, ordered pages-first then fragments, with
 * deduplication so a page that uses the template multiple times shows
 * once (its issues already aggregate at the item level).
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the template→items walk. Issue lookup
 *     stays at the scanner; rendering stays at the route.
 *   - DIP: takes the loaded `Site` + a thin issue-lookup function.
 *     No coupling to the scanner's internal store.
 *   - OCP: adding a new component-nesting shape (e.g., grid columns
 *     carrying templates) extends the recursive walk without
 *     touching the lookup function.
 */
import { allFragmentEntries, allPageEntries, type Site } from '../site-loader.js'
import type { ComponentEntry, FragmentManifest, InlineComponent, PageManifest } from '../types.js'
import { manifestComponents } from './types.js'
import type { Issue } from './types.js'

interface TemplateImpactItem {
  /** Page or fragment. */
  kind: 'page' | 'fragment'
  /** Item name (e.g., 'home' or 'header'). */
  name: string
  /** The language version this row is, when it isn't the default file (#1667). */
  locale?: string
  /** Manifest path matching the scanner's itemPath shape. */
  itemPath: string
  /** Issues from the scanner store for this item. May be empty (clean). */
  issues: readonly Issue[]
}

export interface TemplateImpactResult {
  /** The template the impact view describes. */
  template: string
  /** Items using the template, pages first then fragments. */
  items: readonly TemplateImpactItem[]
  /** Convenience: items.filter(i => i.issues.length > 0).length. */
  affectedItemCount: number
}

/**
 * Compute the impact view for `templateName` against `site`.
 *
 * `issuesFor(itemPath)` is the scanner's per-item issue lookup —
 * passed in so this module stays decoupled from the scanner.
 */
export function computeTemplateImpact(
  site: Site,
  templateName: string,
  issuesFor: (itemPath: string) => readonly Issue[],
  options: { throughFragments?: boolean } = {},
): TemplateImpactResult {
  const items: TemplateImpactItem[] = []
  const seen = new Set<string>()
  // With `throughFragments`, an item also uses the template when it uses a
  // fragment that does, at any depth (#1755). Read from the loaded site only:
  // the fragment-deps sidecars can be stale in a fresh checkout.
  const viaFragments = options.throughFragments ? fragmentsUsing(site, templateName) : new Set<string>()
  const uses = (manifest: PageManifest | FragmentManifest) =>
    usesTemplate(manifest, templateName) ||
    (viaFragments.size > 0 && fragmentRefs(manifestComponents(manifest)).some(f => viaFragments.has(f)))

  // Each language version is its own item, as the scanner checks it (#1667).
  const add = (
    kind: 'page' | 'fragment',
    name: string,
    manifest: PageManifest | FragmentManifest,
    dir: string,
    locale?: string,
  ) => {
    if (!uses(manifest)) return
    const itemPath = `${dir}/${kind}${locale ? `.${locale}` : ''}.json`
    if (seen.has(itemPath)) return
    seen.add(itemPath)
    items.push({ kind, name, ...(locale ? { locale } : {}), itemPath, issues: issuesFor(itemPath) })
  }
  for (const entry of allPageEntries(site)) add('page', entry.name, entry.page, entry.page.dir, entry.locale)
  for (const entry of allFragmentEntries(site))
    add('fragment', entry.name, entry.fragment, entry.fragment.dir, entry.locale)

  const affectedItemCount = items.reduce((n, item) => (item.issues.length > 0 ? n + 1 : n), 0)
  return { template: templateName, items, affectedItemCount }
}

/**
 * Does this manifest (or any of its nested inline components) reference
 * `templateName`? Top-level template + recursive component walk.
 */
function usesTemplate(manifest: PageManifest | FragmentManifest, templateName: string): boolean {
  if (manifest.template === templateName) return true
  return entriesReferenceTemplate(manifestComponents(manifest), templateName)
}

function entriesReferenceTemplate(entries: readonly ComponentEntry[], templateName: string): boolean {
  for (const entry of entries) {
    if (typeof entry === 'string') continue // fragment ref — not a template ref
    const inline = entry as InlineComponent
    if (inline.template === templateName) return true
    if (inline.components && entriesReferenceTemplate(inline.components, templateName)) return true
  }
  return false
}

/** Fragment names directly referenced by `entries`, nested inline components included. */
function fragmentRefs(entries: readonly ComponentEntry[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.startsWith('@')) out.push(entry.slice(1))
      continue
    }
    const inline = entry as InlineComponent
    if (inline.components) out.push(...fragmentRefs(inline.components))
  }
  return out
}

/**
 * Fragments that use `templateName` themselves, or through other fragments,
 * in any of their language versions: a fixed point over the loaded site.
 */
function fragmentsUsing(site: Site, templateName: string): Set<string> {
  const entries = [...allFragmentEntries(site)]
  const using = new Set(entries.filter(e => usesTemplate(e.fragment, templateName)).map(e => e.name))
  let grew = true
  while (grew) {
    grew = false
    for (const e of entries) {
      if (using.has(e.name)) continue
      if (fragmentRefs(manifestComponents(e.fragment)).some(f => using.has(f))) {
        using.add(e.name)
        grew = true
      }
    }
  }
  return using
}
