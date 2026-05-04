import type { FragmentManifest, PageManifest, StorageProvider } from '../types.js'
import type { Site } from '../site-loader.js'
import type { ContentRoot } from '../content-root.js'
import type { Issue, SavedItem, ValidatorInput } from './types.js'
import type { ValidatorRegistry } from './registry.js'

/**
 * Inputs to runSaveDelta. All required — orchestrator does no I/O on the
 * caller's behalf. The save handler reads the existing manifest from storage
 * (when updating) or passes null (when creating) and provides the in-memory
 * site state.
 */
export interface SaveDeltaInput {
  /** What's being saved — page or fragment. */
  item: SavedItem
  /** On-disk manifest before this save (null when creating a new item). */
  before: PageManifest | FragmentManifest | null
  /** The incoming manifest being saved. */
  after: PageManifest | FragmentManifest
  /** Site context loaded by the route handler. */
  site: Site
  contentRoot: ContentRoot
  storage: StorageProvider
}

/**
 * Run all save-delta-stage validators against the saved manifest.
 *
 * Returns the union of issues across all save-delta validators. Validators
 * that don't apply to the item's kind (e.g., circular-fragment on a page)
 * silently produce zero issues. Errors from one validator do not affect
 * others.
 *
 * The route handler decides what to do with the result — typically:
 * non-empty `error` issues → 409 with `{ code, issues }`; otherwise proceed
 * to write the manifest.
 *
 * DIP: orchestrator depends on the registry abstraction. Adding a new
 * save-delta validator is one new file + one entry in `defaultValidatorRegistry()`,
 * with no change here.
 */
export async function runSaveDelta(input: SaveDeltaInput, registry: ValidatorRegistry): Promise<Issue[]> {
  const validatorInput: ValidatorInput = {
    stage: 'save-delta',
    site: input.site,
    contentRoot: input.contentRoot,
    storage: input.storage,
    scope: {
      kind: 'save-delta',
      item: input.item,
      before: input.before,
      after: input.after,
    },
  }

  const validators = registry.forStage('save-delta')
  const results = await Promise.all(
    validators.map(async v => {
      try {
        return await v.validate(validatorInput)
      } catch (err) {
        // Infrastructure error — log and surface as a synthetic issue so the
        // save flow can continue and the author sees something.
        return [
          {
            validator: v.name,
            severity: 'error' as const,
            message: `Validator "${v.name}" failed: ${(err as Error).message}`,
            itemPath: input.item.itemPath,
          },
        ]
      }
    }),
  )
  return results.flat()
}

/**
 * Convenience helper — true when any issue is `error`-severity. Save handlers
 * use this to decide between 409 (block) and proceed.
 */
export function hasBlockingIssues(issues: readonly Issue[]): boolean {
  return issues.some(i => i.severity === 'error')
}
