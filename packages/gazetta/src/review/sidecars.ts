/**
 * Per-edge sidecar storage for content review state.
 *
 * Layout (per `design-review-workflow.md` "Storage shape"):
 *
 *   `{root}/.gazetta/review/{kind}/{encoded-name}/state.json`
 *   `{root}/.gazetta/review/{kind}/{encoded-name}/approvers/{encoded-actor}`
 *
 * Where:
 *   - `{kind}` is `pages` or `fragments` (plural; matches the
 *     `dep-sidecars.ts` item-encoding convention)
 *   - `{encoded-name}` runs through `encodeRefName` so subfolder
 *     manifests collapse safely (e.g., `blog/[slug]` → `blog.[slug]`)
 *   - `{encoded-actor}` runs through `encodeURIComponent` so
 *     email-like actor ids (with `@`, `.`, etc.) round-trip cleanly
 *     to filesystem-safe filenames without dropping characters
 *
 * Approver files are written zero-byte. Their EXISTENCE is the data
 * the threshold check reads — concurrent approvals from different
 * actors write to different paths, so there's no race on the count.
 * Comments (optional approver notes) live inside `state.json` to keep
 * the approver file contract trivially atomic.
 *
 * Why per-edge over a single aggregate state file:
 *   - Multi-instance correctness — two admin instances recording
 *     approvals from `alice` and `bob` write to distinct paths; no
 *     read-modify-write race on a shared counter
 *   - Pattern consistency with `asset-refs` / `fragment-deps` (the
 *     project's locked sidecar shape for write-contention surfaces)
 *   - `readDir` answers "who approved?" in one call without parsing
 *
 * State.json is read-modify-write at the route layer; the storage
 * primitive here is last-write-wins. Approver-count correctness lives
 * in the approvers directory, not in `state.json`.
 */
import type { ContentRoot } from '../content-root.js'
import type { ManifestKey, ReviewSidecar } from '../types.js'
import { encodeRefName } from '../hash.js'

/**
 * Encode `'page' | 'fragment'` into the directory segment used in the
 * sidecar path. Plural form matches the `dep-sidecars.ts` filename
 * convention (`pages.home`) so the project carries one naming rule.
 */
function kindSegment(kind: ManifestKey['kind']): string {
  return kind === 'page' ? 'pages' : 'fragments'
}

function reviewDir(contentRoot: ContentRoot, key: ManifestKey): string {
  return contentRoot.path('.gazetta', 'review', kindSegment(key.kind), encodeRefName(key.name))
}

export function reviewStatePath(contentRoot: ContentRoot, key: ManifestKey): string {
  return `${reviewDir(contentRoot, key)}/state.json`
}

export function approversDir(contentRoot: ContentRoot, key: ManifestKey): string {
  return `${reviewDir(contentRoot, key)}/approvers`
}

/**
 * Path of one approver's zero-byte sidecar. Actor id is
 * `encodeURIComponent`-encoded so emails / OIDC subs / Cloudflare
 * Access identity_nonces all round-trip cleanly across filesystems.
 */
export function approverPath(contentRoot: ContentRoot, key: ManifestKey, actorId: string): string {
  return `${approversDir(contentRoot, key)}/${encodeURIComponent(actorId)}`
}

/**
 * Read the review state.json for one item. Returns null when the
 * sidecar doesn't exist (the item has never entered review) — callers
 * treat absence as `state: 'draft'` per the design's archetype-A
 * default. JSON parse failures bubble as errors so corrupted state
 * files surface loudly rather than silently degrading to "draft."
 */
export async function readReviewState(contentRoot: ContentRoot, key: ManifestKey): Promise<ReviewSidecar | null> {
  const path = reviewStatePath(contentRoot, key)
  let raw: string
  try {
    raw = await contentRoot.storage.readFile(path)
  } catch {
    return null
  }
  return JSON.parse(raw) as ReviewSidecar
}

/**
 * Write the review state.json for one item, replacing any prior
 * contents. Last-write-wins — the route layer is responsible for
 * read-modify-write atomicity when merging concurrent comment updates.
 * Per-approver state stays in the approvers/ directory specifically
 * so this write doesn't carry the count.
 */
export async function writeReviewState(
  contentRoot: ContentRoot,
  key: ManifestKey,
  state: ReviewSidecar,
): Promise<void> {
  const dir = reviewDir(contentRoot, key)
  await contentRoot.storage.mkdir(dir)
  await contentRoot.storage.writeFile(reviewStatePath(contentRoot, key), JSON.stringify(state, null, 2))
}

/**
 * Record one actor's approval. Writes a zero-byte sidecar at the
 * actor's encoded path; idempotent — recording the same actor twice
 * produces the same final state (the second write is a no-op overwrite
 * of a zero-byte file). Multi-instance: two instances recording
 * `alice` and `bob` write to different paths and don't conflict.
 */
export async function recordApprover(contentRoot: ContentRoot, key: ManifestKey, actorId: string): Promise<void> {
  const dir = approversDir(contentRoot, key)
  await contentRoot.storage.mkdir(dir)
  await contentRoot.storage.writeFile(approverPath(contentRoot, key, actorId), '')
}

/**
 * List the actor ids that have recorded approval for this item.
 * Returns an empty array when the approvers directory doesn't exist
 * (no submissions yet, or pre-approval state). Decoded actor ids
 * round-trip through `decodeURIComponent` so emails come back with
 * their original `@`.
 */
export async function readApprovers(contentRoot: ContentRoot, key: ManifestKey): Promise<string[]> {
  const dir = approversDir(contentRoot, key)
  let entries
  try {
    entries = await contentRoot.storage.readDir(dir)
  } catch {
    return []
  }
  const actors: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    actors.push(decodeURIComponent(entry.name))
  }
  return actors
}

/**
 * Clear all approver sidecars for one item — the operation that runs
 * when content is invalidated back to `draft` (per `invalidateOnSave`
 * policy) or when a submission is withdrawn. State.json stays; the
 * caller decides whether to rewrite or delete it.
 *
 * `StorageProvider.rm` removes the directory and its zero-byte
 * children in one call (filesystem provider does a recursive rm;
 * memory provider deletes every key under the prefix). Absent
 * directories are tolerated — the post-condition is "no approver
 * sidecars exist," which an absent directory satisfies.
 */
export async function clearApprovers(contentRoot: ContentRoot, key: ManifestKey): Promise<void> {
  try {
    await contentRoot.storage.rm(approversDir(contentRoot, key))
  } catch {
    /* already gone — no-op */
  }
}
