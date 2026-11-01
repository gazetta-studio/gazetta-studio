/**
 * Which components a save touches (design-agent-access.md Q49): the ones
 * the save's schema check parses. A component is identified by its name
 * path (`hero`, `columns/left`, `''` for the item's own template and
 * content), the same path issues report as `contentPath`.
 *
 * A component is touched when no component at the same path in the
 * stored manifest has the same template and content: it's new, its
 * template changed, or its content changed. Moving a component among
 * its siblings keeps its path, so it isn't touched. Fragment references
 * have no content of their own and are never touched.
 */
import { isDeepStrictEqual } from 'node:util'
import type { ComponentEntry, FragmentManifest, InlineComponent, PageManifest } from '../types.js'

export interface TouchedComponent {
  /** Name path; `''` for the item itself. */
  readonly path: string
  readonly template: string
  readonly content: unknown
}

type Manifest = Pick<PageManifest | FragmentManifest, 'template' | 'content' | 'components'>

/** Components with a template and content, by name path, in manifest order. */
function componentsOf(manifest: Manifest | null): TouchedComponent[] {
  const out: TouchedComponent[] = []
  if (!manifest) return out
  if (manifest.template && manifest.content !== undefined) {
    out.push({ path: '', template: manifest.template, content: manifest.content })
  }
  const walk = (entry: ComponentEntry, parent: string) => {
    if (typeof entry === 'string') return
    const inline = entry as InlineComponent
    const path = parent ? `${parent}/${inline.name}` : inline.name
    if (inline.template && inline.content !== undefined) {
      out.push({ path, template: inline.template, content: inline.content })
    }
    for (const child of inline.components ?? []) walk(child, path)
  }
  for (const entry of manifest.components ?? []) walk(entry, '')
  return out
}

/** The components of `after` that `before` doesn't have unchanged at the same path. */
export function touchedComponents(before: Manifest | null, after: Manifest): TouchedComponent[] {
  const stored = new Map<string, TouchedComponent[]>()
  for (const c of componentsOf(before)) stored.set(c.path, [...(stored.get(c.path) ?? []), c])
  return componentsOf(after).filter(
    c => !stored.get(c.path)?.some(s => s.template === c.template && isDeepStrictEqual(s.content, c.content)),
  )
}
