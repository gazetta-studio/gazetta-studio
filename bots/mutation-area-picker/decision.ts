/**
 * Decision tree for mutation-area-picker.
 *
 * Pure function over scored data. Given the current portfolio cost,
 * a runtime budget, scored un-mutated candidates, and eviction
 * evaluations for scoped modules, returns ADD / SWAP / REMOVE / NOOP.
 *
 * Per [design-mutation-area-picker.md](../../.claude/rules/design-mutation-area-picker.md)
 * §"Decision criteria detail" and §"Bootstrap".
 */
import type { EvictionEvaluation } from './scoring.js'

export interface UnMutatedCandidate {
  modulePath: string
  inclusionScore: number
  estimatedRuntimeMinutes: number
}

export interface ScopedModule {
  modulePath: string
  eviction: EvictionEvaluation
  /** Estimated current contribution to nightly mutation runtime. */
  estimatedRuntimeMinutes: number
}

export interface DecisionInput {
  unMutated: UnMutatedCandidate[]
  scoped: ScopedModule[]
  /** Current portfolio's estimated nightly runtime. */
  currentRuntimeMinutes: number
  /** Hard budget — no ADD that would exceed this. */
  budgetMinutes: number
  /** True during weeks 1-4: bot does ADD only, no eviction. */
  inBootstrap: boolean
  /** Min inclusion score to justify ADD. Default 0.4 per design doc. */
  inclusionThreshold: number
  /** Min eviction score to consider SWAP/REMOVE. Default 0.7. */
  evictionThreshold: number
}

export type Decision =
  | { action: 'add'; module: string; reasoning: string }
  | { action: 'swap'; addModule: string; removeModule: string; reasoning: string }
  | { action: 'remove'; module: string; reasoning: string }
  | { action: 'noop'; reasoning: string }

/**
 * Apply the decision tree. Returns the action to take and a
 * human-readable reasoning string for the PR body / reviewer-log.
 */
export function decide(input: DecisionInput): Decision {
  const {
    unMutated,
    scoped,
    currentRuntimeMinutes,
    budgetMinutes,
    inBootstrap,
    inclusionThreshold,
    evictionThreshold,
  } = input

  // Sort candidates: best first
  const sortedCandidates = [...unMutated].sort((a, b) => b.inclusionScore - a.inclusionScore)
  const top = sortedCandidates[0]

  // ─── ADD path ────────────────────────────────────────────────────────────
  // First check whether the top candidate has both headroom AND clears the
  // threshold. If yes, ADD wins regardless of bootstrap state.
  if (top && top.inclusionScore >= inclusionThreshold) {
    const wouldFit = currentRuntimeMinutes + top.estimatedRuntimeMinutes <= budgetMinutes
    if (wouldFit) {
      return {
        action: 'add',
        module: top.modulePath,
        reasoning: `Top candidate scored ${top.inclusionScore.toFixed(3)} (≥ threshold ${inclusionThreshold}). Budget headroom: estimated ${top.estimatedRuntimeMinutes.toFixed(1)} min + current ${currentRuntimeMinutes.toFixed(1)} ≤ budget ${budgetMinutes}.`,
      }
    }
  }

  // ─── Bootstrap stops here ────────────────────────────────────────────────
  // Weeks 1-4: no eviction (insufficient kill-ratio history). If ADD didn't
  // fire, the bot exits NOOP regardless of what eviction would suggest.
  if (inBootstrap) {
    if (!top) {
      return { action: 'noop', reasoning: 'No un-mutated candidates available.' }
    }
    if (top.inclusionScore < inclusionThreshold) {
      return {
        action: 'noop',
        reasoning: `Bootstrap mode: top candidate ${top.modulePath} scored ${top.inclusionScore.toFixed(3)} < threshold ${inclusionThreshold}. No ADD justified.`,
      }
    }
    // top scored above threshold but didn't fit — bootstrap blocks eviction
    return {
      action: 'noop',
      reasoning: `Bootstrap mode: top candidate ${top.modulePath} (score ${top.inclusionScore.toFixed(3)}) would exceed budget; eviction disabled until week 5.`,
    }
  }

  // ─── At-budget paths (post-bootstrap) ────────────────────────────────────
  // Find the scoped module closest to graduating
  const sortedScoped = [...scoped].sort((a, b) => b.eviction.score - a.eviction.score)
  const bestForEviction = sortedScoped[0]

  // SWAP / REMOVE: best scoped is eviction-ripe. SWAP if a good un-mutated
  // candidate exists to replace it; REMOVE otherwise (free budget for
  // future weeks). Note `top` may be undefined here — REMOVE doesn't
  // require an un-mutated candidate to exist.
  if (bestForEviction && bestForEviction.eviction.evicts && bestForEviction.eviction.score >= evictionThreshold) {
    if (top && top.inclusionScore > bestForEviction.eviction.score) {
      return {
        action: 'swap',
        addModule: top.modulePath,
        removeModule: bestForEviction.modulePath,
        reasoning: `Top candidate ${top.modulePath} (inclusion ${top.inclusionScore.toFixed(3)}) outranks ${bestForEviction.modulePath} (eviction ${bestForEviction.eviction.score.toFixed(3)}). ${bestForEviction.modulePath} has graduated: ${bestForEviction.eviction.reason ?? 'kill-ratio sustained + fix-rate met'}.`,
      }
    }
    // No good replacement (either no candidates at all, or the best
    // candidate is below the SWAP bar) — REMOVE to free budget.
    const noCandidateNote = top
      ? `best un-mutated candidate: ${top.modulePath} at ${top.inclusionScore.toFixed(3)} (below scoped's eviction score)`
      : 'no un-mutated candidates available'
    return {
      action: 'remove',
      module: bestForEviction.modulePath,
      reasoning: `${bestForEviction.modulePath} has graduated (eviction score ${bestForEviction.eviction.score.toFixed(3)} ≥ threshold ${evictionThreshold}). ${noCandidateNote}. Removing to free budget.`,
    }
  }

  // ─── NOOP ─────────────────────────────────────────────────────────────────
  if (!top) {
    return { action: 'noop', reasoning: 'No un-mutated candidates available.' }
  }
  if (top.inclusionScore < inclusionThreshold) {
    return {
      action: 'noop',
      reasoning: `Top candidate ${top.modulePath} scored ${top.inclusionScore.toFixed(3)} < threshold ${inclusionThreshold}. No scope change justified.`,
    }
  }
  // top scored well but no headroom + no eviction-ripe scoped
  const closenessSummary = bestForEviction
    ? `closest scoped to graduation: ${bestForEviction.modulePath} (score ${bestForEviction.eviction.score.toFixed(3)}, ${bestForEviction.eviction.reason ?? 'eligible'})`
    : 'no scoped modules to consider'
  return {
    action: 'noop',
    reasoning: `Top candidate ${top.modulePath} (score ${top.inclusionScore.toFixed(3)}) would exceed budget; no scoped module has graduated yet. ${closenessSummary}.`,
  }
}
