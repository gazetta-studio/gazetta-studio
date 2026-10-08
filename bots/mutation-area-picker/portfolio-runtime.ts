/**
 * Pure functions for deriving the current portfolio runtime from
 * observed nightly Stryker runs.
 *
 * Prior shape (replaced by issue #871): `CURRENT_RUNTIME_MINUTES`
 * was a static env default (105). Because the per-module runtime
 * estimate is `scopedLOC × (CURRENT_RUNTIME_MINUTES / totalScopedLOC)`,
 * the scoped set's sum always re-collapsed to CURRENT_RUNTIME_MINUTES
 * no matter how many modules the bot had added. The 150-min budget
 * check never saw growth.
 *
 * The orchestrator feeds observed step durations here; this module
 * owns the duration-math and the "max of recent runs" statistic,
 * tested without I/O. The GitHub-API call that produces the ISO
 * timestamps lives in signal-env.ts.
 *
 * Why MAX (not median / avg): the budget check is a worst-case
 * guard — "will nightly complete inside the 180-min hard ceiling?".
 * A median under-estimates the tail; the max of the last few runs
 * is the conservative anchor.
 */

/**
 * Return the duration between two ISO-8601 timestamps in minutes, or
 * null when either input is missing, unparseable, or non-monotonic.
 *
 * Non-monotonic (completed < started) returns null defensively — a
 * negative duration fed into calibration would silently inflate the
 * minutes-per-line factor.
 */
export function computeStepDurationMinutes(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null
  const startMs = Date.parse(startedAt)
  const endMs = Date.parse(completedAt)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
  if (endMs < startMs) return null
  return (endMs - startMs) / 60_000
}

/**
 * Return the conservative portfolio-runtime estimate (max of the
 * given durations in minutes), or null when no finite value is
 * available.
 *
 * NaN / Infinity entries are dropped — the fetcher may surface them
 * if a specific run's step metadata is incomplete.
 */
export function derivePortfolioRuntimeMinutes(durationsMinutes: readonly number[]): number | null {
  const finite = durationsMinutes.filter(n => Number.isFinite(n))
  if (finite.length === 0) return null
  return Math.max(...finite)
}
