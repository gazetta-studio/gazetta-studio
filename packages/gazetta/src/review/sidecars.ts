/**
 * Per-edge sidecar storage for review workflow.
 *
 * Shape, per `design-review-workflow.md` "Storage shape":
 *
 *   `{root}/.gazetta/review/{kind}s/{encoded-name}/state.json`
 *   `{root}/.gazetta/review/{kind}s/{encoded-name}/approvers/{encoded-actor}`
 *
 * The `state.json` carries the full `ReviewSidecar` payload. The
 * `approvers/{actor}` entries are zero-byte sidecars — the file's
 * EXISTENCE is the "this actor has voted" signal. Comments and
 * timestamps live inside state.json's `approvers` array; the zero-
 * byte sidecars exist so the threshold check ("did we hit
 * `requiredApprovers`?") can be computed via `readDir` without
 * reading state.json first — the race-free step in the concurrent-
 * approval dance.
 *
 * Why per-edge sidecars for approvers (not an in-state.json-only
 * list), per `design-review-workflow.md` "Concurrent approval race
 * tolerance":
 *   - Two instances approving concurrently write to DIFFERENT
 *     per-approver paths (`approvers/alice` vs `approvers/bob`); no
 *     race on writes.
 *   - Readers compute "is threshold met?" via `readDir` AFTER
 *     writing the per-approver sidecar; the aggregate state.json
 *     write is idempotent (last-write-wins on `state: approved` —
 *     both racing instances compute identical state when the
 *     threshold is met).
 *   - Granularity solves the write-contention problem an aggregate
 *     JSON would face. Same pattern as `asset-refs` / `fragment-deps`
 *     under the generic `dep-sidecars.ts` abstraction.
 *
 * Design note on NOT reusing `dep-sidecars.ts` directly:
 *   - The dep-sidecar abstraction is tailored to the "reverse-rooted
 *     dependency graph" shape — one target name, many source items,
 *     filenames encode `pages.{name}` or `fragments.{name}`.
 *   - Review has a different per-edge shape: one subject (the item
 *     under review) × many approvers (actor IDs). Actor IDs can
 *     contain characters `encodeRefName` deliberately forbids (dots,
 *     slashes, @-signs for email-shaped IDs), so a separate
 *     filesystem-safe encoding is needed.
 *   - The multi-instance correctness guarantee is the same (per-edge
 *     granularity → race-free different-path writes); the two
 *     modules share no code because the encoding + directory shape
 *     differ.
 *
 * Single responsibility: filename encoding + per-scope I/O. The
 * state-machine (Cut 4) composes these primitives with the FSM to
 * drive transitions; the admin routes (Cut 7) compose both.
 */
import type { ContentRoot } from '../content-root.js'
import { encodeRefName } from '../hash.js'
import type { ReviewScope, ReviewSidecar } from './types.js'

const REVIEW_ROOT = '.gazetta/review'
const APPROVERS_SEGMENT = 'approvers'
const STATE_FILE = 'state.json'

/**
 * Encode a `Principal.id` into a filesystem-safe sidecar filename.
 *
 * Actor IDs are arbitrary strings (OIDC `sub`, Cloudflare Access
 * identity_nonce, email-shaped IDs like `alice@example.com`, etc.).
 * They can contain characters that aren't filesystem-safe on all
 * platforms (`/` is a path separator everywhere; `:` fails on
 * Windows). We can't funnel them through `encodeRefName` because
 * that rejects dots — and real-world actor IDs commonly contain
 * dots (`sub` claims, email domains).
 *
 * `encodeURIComponent` gives a reversible, filesystem-safe encoding
 * for every reasonable input, matching how web standards encode
 * arbitrary strings for use as path segments. Reversed via
 * `decodeActorId`.
 */
export function encodeActorId(actorId: string): string {
  return encodeURIComponent(actorId)
}

/** Reverse of {@link encodeActorId}. */
export function decodeActorId(encoded: string): string {
  return decodeURIComponent(encoded)
}

/**
 * Directory holding this scope's state + approvers:
 *   `{root}/.gazetta/review/{kind}s/{encoded-name}`.
 *
 * Kind is pluralised in the path (`pages`, `fragments`) to match the
 * content tree's directory names — operators reading storage see
 * `review/pages/home/` paralleling `pages/home/`.
 */
export function reviewScopeDir(contentRoot: ContentRoot, scope: ReviewScope): string {
  return contentRoot.path(REVIEW_ROOT, pluralKind(scope.kind), encodeRefName(scope.name))
}

/** Path for the state.json file inside the scope dir. */
export function reviewStatePath(contentRoot: ContentRoot, scope: ReviewScope): string {
  return `${reviewScopeDir(contentRoot, scope)}/${STATE_FILE}`
}

/** Directory holding one zero-byte file per approver. */
export function reviewApproversDir(contentRoot: ContentRoot, scope: ReviewScope): string {
  return `${reviewScopeDir(contentRoot, scope)}/${APPROVERS_SEGMENT}`
}

/** Path for one approver's zero-byte sidecar file. */
export function reviewApproverPath(contentRoot: ContentRoot, scope: ReviewScope, actorId: string): string {
  return `${reviewApproversDir(contentRoot, scope)}/${encodeActorId(actorId)}`
}

/**
 * Read the state.json for a scope. Returns `null` when the file is
 * missing (content hasn't entered the review pipeline, which equals
 * `state: draft`). Treats any read failure as "no state here" —
 * storage providers vary in exact error shape (filesystem's
 * `File not found`, memory's `ENOENT`, cloud providers return their
 * SDK's error), so we don't try to discriminate by error-code
 * matching. Same pattern as `dep-sidecars.ts`'s `readDepsFor`.
 *
 * JSON parse errors are NOT caught — a malformed state.json is a
 * real bug the caller should see, not a "treat as draft" signal.
 */
export async function readReviewSidecar(contentRoot: ContentRoot, scope: ReviewScope): Promise<ReviewSidecar | null> {
  let raw: string
  try {
    raw = await contentRoot.storage.readFile(reviewStatePath(contentRoot, scope))
  } catch {
    return null
  }
  return JSON.parse(raw) as ReviewSidecar
}

/**
 * Write (or overwrite) the state.json for a scope. Caller supplies
 * the full sidecar — this module just persists bytes. Idempotent at
 * the storage layer: writing the same bytes twice has the same
 * effect as writing once.
 */
export async function writeReviewSidecar(
  contentRoot: ContentRoot,
  scope: ReviewScope,
  sidecar: ReviewSidecar,
): Promise<void> {
  const dir = reviewScopeDir(contentRoot, scope)
  await contentRoot.storage.mkdir(dir).catch(() => {
    // Already exists — fine. mkdir semantics vary across providers
    // (filesystem returns ENOENT when parent is missing but typically
    // supports recursive; cloud providers no-op). We tolerate the
    // common error cases rather than branch per provider.
  })
  await contentRoot.storage.writeFile(reviewStatePath(contentRoot, scope), `${JSON.stringify(sidecar, null, 2)}\n`)
}

/**
 * Remove the entire review state for a scope — state.json AND every
 * per-approver sidecar. Used by the FSM when content returns to
 * `draft` (reject, withdraw, or invalidate), so the next submission
 * starts fresh with no stale votes.
 */
export async function removeReviewSidecar(contentRoot: ContentRoot, scope: ReviewScope): Promise<void> {
  await contentRoot.storage.rm(reviewScopeDir(contentRoot, scope)).catch(() => {
    // Already gone — fine. rm is idempotent for our purposes.
  })
}

/**
 * Write the zero-byte approver sidecar for `(scope, actorId)`.
 * Idempotent: concurrent writes of the same (scope, actor) pair are
 * safe (same path, same bytes). Writes to different approver paths
 * never contend — the per-edge granularity is the whole point.
 *
 * The function does NOT update state.json's approvers list. Callers
 * follow the design-review-workflow.md pattern:
 *   1. writeReviewApprover(scope, actor)  — race-free vote
 *   2. readReviewApprovers(scope)         — did we hit threshold?
 *   3. writeReviewSidecar(scope, next)    — persist new state (idempotent on `approved`)
 */
export async function writeReviewApprover(
  contentRoot: ContentRoot,
  scope: ReviewScope,
  actorId: string,
): Promise<void> {
  const dir = reviewApproversDir(contentRoot, scope)
  await contentRoot.storage.mkdir(dir).catch(() => {
    // Already exists — fine.
  })
  await contentRoot.storage.writeFile(reviewApproverPath(contentRoot, scope, actorId), '')
}

/**
 * Remove one approver's sidecar. Idempotent (ENOENT tolerated).
 * v1 has no "retract my approval" admin action per
 * `design-review-workflow.md` Q-A, but this primitive makes the
 * `removeReviewSidecar` directory-walk honest and keeps the surface
 * complete for future unapprove flows.
 */
export async function removeReviewApprover(
  contentRoot: ContentRoot,
  scope: ReviewScope,
  actorId: string,
): Promise<void> {
  await contentRoot.storage.rm(reviewApproverPath(contentRoot, scope, actorId)).catch(() => {
    // Already gone — fine.
  })
}

/**
 * List actor IDs that have approved this scope's current review by
 * reading the `approvers/` directory. Returns an empty array when
 * the directory is missing (no approvals yet) or empty. Order
 * follows storage's `readDir` order; callers should not depend on
 * it (filesystem returns alphabetical; cloud providers vary).
 */
export async function readReviewApprovers(contentRoot: ContentRoot, scope: ReviewScope): Promise<string[]> {
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await contentRoot.storage.readDir(reviewApproversDir(contentRoot, scope))
  } catch {
    return []
  }
  const actors: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    actors.push(decodeActorId(entry.name))
  }
  return actors
}

function pluralKind(kind: ReviewScope['kind']): string {
  return kind === 'page' ? 'pages' : 'fragments'
}
