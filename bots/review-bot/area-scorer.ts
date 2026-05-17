/**
 * Phase 0 area-scorer — TS-side narrowing of "which area is worth
 * reviewing next?" The output is a top-5 candidate list the LLM
 * picker then chooses from.
 *
 * Producer/consumer split (per bots/README.md): the scorer is the
 * producer — deterministic, testable, no LLM judgment. The LLM is the
 * consumer — picks one of the 5 with reasoning. Pushing the sort to
 * Claude would burn context on what bash + git can do reliably.
 *
 * Signals (v1):
 *
 *   1. Recency       — files touched in the last N days; areas with
 *                       higher touch-counts are more likely to have
 *                       issues worth flagging
 *   2. Cold-on-bot   — when did review-bot last open an improve/* PR
 *                       in this area? Areas the bot hasn't touched
 *                       lately are more eligible (avoid same-area loops)
 *   3. Skip-list-aware — exclude areas with active skip-list entries
 *
 * Signals deferred to v1.5+ (need cheaper access to the underlying
 * data than v1's heuristics can provide):
 *
 *   - Validator findings per area (would need to run validators)
 *   - Mutation surviving counts per area (cross-bot coupling with
 *     mutation-watcher's artifacts)
 *   - Coverage gaps per area (no coverage data is committed)
 *
 * Default scoring weights are documented intuitions, NOT measurement-
 * derived. Cut 21 (post-merge production tuning) measures real signal
 * against maintainer-merged outcomes and adjusts.
 *
 * See design-code-review.md "Review-bot (autonomous)" + design-code-
 * review-implementation.md P4.
 */
import type { SkipList } from './skip-list.js'

export interface AreaCandidate {
  /** Repo-relative directory path, ending with '/' for clarity. */
  area: string
  /** Composite score (higher = more eligible). */
  score: number
  /** Files in this area touched in the recency window. */
  touchedFiles: number
  /** Days since review-bot last opened an improve/* PR here (or Infinity). */
  daysSinceBotTouched: number
  /** Whether ANY part of this area is currently skip-listed (Phase 2 also re-checks). */
  hasSkipListMatch: boolean
}

export interface ScoreOptions {
  /** Files touched within this many days count toward recency. Default 30. */
  recencyDays?: number
  /** Maximum area-depth (slashes after repo root). Default 3 — matches design-doc scope. */
  maxDepth?: number
  /** Minimum touched-files to qualify as a candidate area. Default 3. */
  minTouchedFiles?: number
  /** How many candidates to return. Default 5 (matches LLM picker's context budget). */
  topN?: number
  /** Glob roots to consider. Default: ['packages/', 'apps/', 'bots/', 'tools/']. */
  considerRoots?: readonly string[]
}

/** Internal shape: per-file-line output of `git log --name-only`. */
export interface GitFileTouch {
  /** Repo-relative file path. */
  path: string
  /** ISO date of the commit that touched it (most recent). */
  lastTouchedAt: string
}

/**
 * Score areas given the raw signals. Pure function — testable in
 * isolation with synthetic inputs.
 *
 * @param touches Recent file touches from git log (caller fetches via spawn)
 * @param botPRs Areas review-bot has opened PRs in, with ISO timestamps
 * @param skipList Current skip-list contents
 * @param opts Scoring options
 */
export function scoreAreas(
  touches: readonly GitFileTouch[],
  botPRs: ReadonlyMap<string, string>,
  skipList: SkipList,
  opts: ScoreOptions = {},
): AreaCandidate[] {
  const maxDepth = opts.maxDepth ?? 3
  const minTouchedFiles = opts.minTouchedFiles ?? 3
  const topN = opts.topN ?? 5
  const considerRoots = opts.considerRoots ?? ['packages/', 'apps/', 'bots/', 'tools/']

  // Group files by area at the configured depth.
  const areaTouches = new Map<string, number>()
  for (const touch of touches) {
    if (!considerRoots.some((r) => touch.path.startsWith(r))) continue
    const area = areaOf(touch.path, maxDepth)
    if (!area) continue
    areaTouches.set(area, (areaTouches.get(area) ?? 0) + 1)
  }

  // Build candidates.
  const now = Date.now()
  const candidates: AreaCandidate[] = []
  for (const [area, touchedFiles] of areaTouches.entries()) {
    if (touchedFiles < minTouchedFiles) continue

    const lastBotTouchIso = botPRs.get(area)
    const daysSinceBotTouched = lastBotTouchIso
      ? (now - new Date(lastBotTouchIso).getTime()) / (1000 * 60 * 60 * 24)
      : Number.POSITIVE_INFINITY

    const hasSkipListMatch = areaHasSkipListMatch(area, skipList)
    if (hasSkipListMatch) continue

    candidates.push({
      area,
      touchedFiles,
      daysSinceBotTouched,
      hasSkipListMatch,
      score: scoreOne(touchedFiles, daysSinceBotTouched),
    })
  }

  // Sort descending by score; take top N.
  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, topN)
}

/**
 * Compute the composite score for one area.
 *
 * Default weights (un-measured; tuned in Cut 21):
 *
 *   - touchedFiles: linear contribution; more activity → more candidates
 *     surfaced → more chance the bot finds something worth fixing
 *   - daysSinceBotTouched: capped multiplicative bonus; areas the bot
 *     ignored for a while get attention; capped so an area the bot
 *     never visits doesn't dominate forever
 *
 * Exported for testing + future-tuning visibility.
 */
export function scoreOne(touchedFiles: number, daysSinceBotTouched: number): number {
  // Recency bonus: cap at 60 days so an untouched area doesn't get an
  // infinite score (Number.POSITIVE_INFINITY * anything = NaN trouble).
  const recencyBonus = Math.min(60, daysSinceBotTouched === Number.POSITIVE_INFINITY ? 60 : daysSinceBotTouched)
  // 0.5 weight on the recency bonus keeps active areas competitive
  // against long-untouched ones. Tunable in Cut 21.
  return touchedFiles + 0.5 * recencyBonus
}

/**
 * Compute the area prefix for a given file path at the configured depth.
 *
 * Examples (maxDepth=3):
 *   packages/gazetta/src/auth/principal.ts -> packages/gazetta/src/auth/
 *   packages/gazetta/src/auth/sub/foo.ts   -> packages/gazetta/src/auth/  (depth-capped)
 *   apps/admin/src/foo.ts                  -> apps/admin/src/
 *   bots/fix-bot/index.ts                  -> bots/fix-bot/
 *   README.md                              -> null  (too shallow)
 */
export function areaOf(path: string, maxDepth: number): string | null {
  const parts = path.split('/')
  if (parts.length < 2) return null // top-level file; not an area
  // Take min(parts.length - 1, maxDepth) segments; ensure trailing slash.
  const depth = Math.min(parts.length - 1, maxDepth)
  if (depth < 1) return null
  return `${parts.slice(0, depth).join('/')}/`
}

/** True when ANY skip-list entry's area falls within (or contains) the given area. */
function areaHasSkipListMatch(area: string, skipList: SkipList): boolean {
  // Cheap check: walk entries + see if the entry's area path overlaps
  // this area in either direction (skip-list area inside our area, or
  // our area inside the skip-list area). The rules layer's glob match
  // is handled by isSkipped per-fingerprint downstream.
  for (const entry of skipList.entries) {
    if (entry.fingerprint.area.startsWith(area) || area.startsWith(entry.fingerprint.area)) {
      return true
    }
  }
  // Rules: synthesize a fake fingerprint at this area to check; type
  // is set to a wildcard-ish 'correctness' but isSkipped's rule type-
  // filter would skip it. Conservative: assume any matching rule
  // applies; downstream Phase 2 picks the actual candidate which
  // re-checks per its real type.
  return skipList.rules.some((rule) => {
    const ruleScope = rule.scope.endsWith('/') ? rule.scope : `${rule.scope}/`
    return ruleScope.startsWith(area) || area.startsWith(ruleScope.replace(/\*\*$/, '').replace(/\*+$/, ''))
  })
}
