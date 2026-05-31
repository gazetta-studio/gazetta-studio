/**
 * Shared kind-discriminated lookup of a page or fragment manifest on a
 * loaded `Site`.
 *
 * Extracted from `archive.ts`, `rename.ts`, and `redirects.ts` once the
 * third hand-rolled copy landed in PR #461 (cut #446) — per
 * [team-preferences.md rule 15](../../../.claude/rules/team-preferences.md)
 * the 3-caller threshold for extraction was met.
 *
 * The helper takes a bare `'page' | 'fragment'` discriminator rather
 * than either of the caller-side typed wrappers (`ItemHandle` /
 * `KindBinding`). Keeps the interface narrow + avoids cross-importing
 * unrelated wrapper types into the routes that don't use them.
 */
import type { Site } from '../site-loader.js'
import type { FragmentManifest, PageManifest } from '../types.js'

export function lookupManifest(
  site: Site,
  kind: 'page' | 'fragment',
  name: string,
): (PageManifest | FragmentManifest) | undefined {
  return kind === 'page' ? site.pages.get(name) : site.fragments.get(name)
}
