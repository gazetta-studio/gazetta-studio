/**
 * Score composers for mutation-area-picker.
 *
 * Inclusion: 5-signal weighted composite, [0, 1]. Each raw signal is
 * normalised to [0, 1] across the candidate set before weighting —
 * a module with 10 AI-paired commits in a set where the max is 12
 * scores ~0.83 on that dimension, not 10.0. Normalisation makes
 * the weights well-defined regardless of absolute magnitudes.
 *
 * Eviction: composite AND predicate per ADR-0014. A module graduates
 * (returns true) only when BOTH kill-ratio-sustained AND
 * fix-rate-high hold. Neither alone is sufficient.
 */
import type { EvictionSignals, InclusionSignals } from './signals.js'

// ─────────────────────────────────────────────────────────────────────────────
// Inclusion scoring
// ─────────────────────────────────────────────────────────────────────────────

export interface InclusionWeights {
  aiPairingDensity: number
  testCoverageRatioInverse: number
  recentChurn: number
  flakeCorrelation: number
  bugFixCorrelation: number
}

/**
 * Default weights per design-mutation-area-picker.md.
 * Sum = 1.0. Weights are initial guesses; recalibration happens via
 * lessons-learned.md after 4-6 PRs of accumulated data.
 */
export const DEFAULT_WEIGHTS: InclusionWeights = {
  aiPairingDensity: 0.3,
  testCoverageRatioInverse: 0.25,
  recentChurn: 0.2,
  flakeCorrelation: 0.15,
  bugFixCorrelation: 0.1,
}

/**
 * Normalise a raw signal to [0, 1] across the candidate set.
 * If the max is 0 (e.g. nobody has AI-pairing in the set), all
 * candidates score 0 on that dimension — neutral, no contribution.
 * testCoverageRatioInverse is already pre-normalised to [0, 1] by
 * the signal collector; the function detects this and leaves it as
 * raw value.
 */
export function normalise(values: number[]): number[] {
  const max = Math.max(...values, 0)
  if (max === 0) return values.map(() => 0)
  return values.map(v => v / max)
}

/**
 * Compute composite inclusion scores for a candidate set. Returns
 * scores in the same order as the input.
 *
 * The weights argument allows operator override via env or future
 * lessons-learned recalibration; defaults match the design doc.
 */
export function composeInclusionScores(
  candidates: InclusionSignals[],
  weights: InclusionWeights = DEFAULT_WEIGHTS,
): number[] {
  // Test/coverage ratio is already in [0, 1] from the collector;
  // pass through as-is. The others are absolute counts and need
  // normalisation across the candidate set.
  const aiPaired = normalise(candidates.map(c => c.aiPairingDensity))
  const churn = normalise(candidates.map(c => c.recentChurn))
  const flake = normalise(candidates.map(c => c.flakeCorrelation))
  const bugFix = normalise(candidates.map(c => c.bugFixCorrelation))

  return candidates.map(
    (c, i) =>
      weights.aiPairingDensity * aiPaired[i] +
      weights.testCoverageRatioInverse * c.testCoverageRatioInverse +
      weights.recentChurn * churn[i] +
      weights.flakeCorrelation * flake[i] +
      weights.bugFixCorrelation * bugFix[i],
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Eviction predicate (per ADR-0014)
// ─────────────────────────────────────────────────────────────────────────────

export interface EvictionThresholds {
  /** Kill ratio that each of the last N runs must exceed. Default 0.85. */
  killRatio: number
  /** Min entries in killRatioHistory; below this, never graduates. Default 4. */
  minHistoryLength: number
  /** Min fix rate (closedMerged / total) for mutation-watcher issues. Default 0.7. */
  fixRate: number
  /** Min mutation-issues count; below this we don't have enough signal to evaluate. Default 1. */
  minIssueCount: number
}

export const DEFAULT_EVICTION_THRESHOLDS: EvictionThresholds = {
  killRatio: 0.85,
  minHistoryLength: 4,
  fixRate: 0.7,
  minIssueCount: 1,
}

export interface EvictionEvaluation {
  /** True when both conditions hold and the module is eligible to graduate. */
  evicts: boolean
  /** Numeric "how close" score in [0, 1] — useful for ranking when no module fully evicts. */
  score: number
  /** Which condition failed when evicts=false; null when both pass. */
  reason: string | null
}

/**
 * Apply the ADR-0014 empirical eviction rule. Returns whether the
 * module graduates AND a numeric "closeness" score for ranking
 * purposes when no module fully evicts.
 *
 * The score is the GEOMETRIC MEAN of the two component sub-scores
 * (kill-ratio-headroom, fix-rate). Geometric mean penalises imbalance:
 * a module with kill ratio 0.95 but fix rate 0.1 scores low, not high.
 * That matches the AND semantics of the predicate.
 */
export function evaluateEviction(
  signals: EvictionSignals,
  thresholds: EvictionThresholds = DEFAULT_EVICTION_THRESHOLDS,
): EvictionEvaluation {
  // History too short → cannot evaluate; module stays (bootstrap)
  if (signals.killRatioHistory.length < thresholds.minHistoryLength) {
    return {
      evicts: false,
      score: 0,
      reason: `history too short (${signals.killRatioHistory.length}/${thresholds.minHistoryLength} weeks)`,
    }
  }

  // Sub-score 1: kill-ratio headroom — how much each recent ratio
  // exceeds the threshold. If any single ratio falls below, the
  // SUSTAINED condition fails (we use min, not mean).
  const minRatio = Math.min(...signals.killRatioHistory)
  const ratioComponent = Math.max(
    0,
    Math.min(1, (minRatio - thresholds.killRatio) / (1 - thresholds.killRatio + 0.001) + 0.5),
  )
  const ratioPasses = minRatio >= thresholds.killRatio

  // Sub-score 2: fix rate — fraction of mutation-watcher issues closed-merged.
  if (signals.mutationIssuesTotal < thresholds.minIssueCount) {
    return {
      evicts: false,
      score: ratioComponent * 0.5, // signal incomplete; score conservatively
      reason: `not enough mutation-watcher issues (${signals.mutationIssuesTotal}/${thresholds.minIssueCount})`,
    }
  }
  const fixRate = signals.mutationIssuesClosedMerged / signals.mutationIssuesTotal
  const fixRateComponent = Math.max(
    0,
    Math.min(1, (fixRate - thresholds.fixRate) / (1 - thresholds.fixRate + 0.001) + 0.5),
  )
  const fixRatePasses = fixRate >= thresholds.fixRate

  // Geometric mean for combined score
  const score = Math.sqrt(ratioComponent * fixRateComponent)

  if (ratioPasses && fixRatePasses) {
    return { evicts: true, score, reason: null }
  }
  const reason = !ratioPasses
    ? `kill ratio ${(minRatio * 100).toFixed(1)}% below ${(thresholds.killRatio * 100).toFixed(0)}%`
    : `fix rate ${(fixRate * 100).toFixed(1)}% below ${(thresholds.fixRate * 100).toFixed(0)}%`
  return { evicts: false, score, reason }
}
