/**
 * Fragment-deps binding for the generic dep-sidecars module.
 *
 * Answers "which pages/fragments use `@fragmentX`?" via the same per-edge
 * sidecar shape as asset-refs. Replaces the on-demand walk that
 * `findDependentsFromSidecars` did over forward `.uses-*` sidecars.
 *
 * Sidecars live at:
 *   `{root}/.gazetta/fragment-deps/{fragmentName}/{encoded-source-item}`
 *
 * Source-and-target consistent — written by save handlers (source) and
 * by the publish flow (target) the same way asset-refs is written.
 */
import type { ContentRoot } from './content-root.js'
import {
  type DepRelation,
  type ItemRef,
  type ManifestLike,
  applyDepDiff,
  rebuildItemDeps,
  readDepsFor,
} from './dep-sidecars.js'
import { collectFragmentRefs } from './sidecars.js'

/** The fragment-deps relation: extract `@fragment` references from a manifest. */
export const FRAGMENT_DEPS: DepRelation = {
  rootName: 'fragment-deps',
  extract: (manifest: ManifestLike) => new Set(collectFragmentRefs(manifest.components as unknown[] | undefined)),
}

/** Read every item that references this fragment. Thin wrapper around `readDepsFor`. */
export function readDepsForFragment(contentRoot: ContentRoot, fragmentName: string): Promise<ItemRef[]> {
  return readDepsFor(FRAGMENT_DEPS, contentRoot, fragmentName)
}

/** Apply fragment-deps diff for one item's manifest change. */
export function rebuildFragmentDeps(
  contentRoot: ContentRoot,
  item: ItemRef,
  oldManifest: ManifestLike | null,
  newManifest: ManifestLike | null,
): Promise<void> {
  return rebuildItemDeps(FRAGMENT_DEPS, contentRoot, item, oldManifest, newManifest)
}

/** Apply a pre-computed diff (used in tests + cases where caller has the sets already). */
export function applyFragmentDepsDiff(
  contentRoot: ContentRoot,
  item: ItemRef,
  oldFragments: ReadonlySet<string>,
  newFragments: ReadonlySet<string>,
): Promise<void> {
  return applyDepDiff(FRAGMENT_DEPS, contentRoot, item, oldFragments, newFragments)
}
