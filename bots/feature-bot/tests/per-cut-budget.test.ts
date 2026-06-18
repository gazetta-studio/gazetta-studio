/**
 * Per-cut budget guard — behavior tests for the cut-scoped escalation
 * decision rule.
 *
 * Context: prior to this helper, `index.ts` anchored the per-cut
 * timing comparison on a module-level `const PROCESS_START = Date.now()`
 * captured at module-init time. That meant cut #2 in a cron run
 * inherited cut #1's elapsed time and could escalate prematurely,
 * defeating the "graceful NEEDS_HUMAN before workflow hard-kill" goal
 * documented at index.ts lines 94-103.
 *
 * The fix extracts the comparison into a pure helper whose signature
 * REQUIRES a `cutStart` argument — encoding the cut-scoped anchor
 * invariant in the type system rather than as a regex over source
 * text (rule 41 — the prior structural test was pruned per Agent B's
 * review note).
 *
 * Pattern mirrors `decideIdempotency` (idempotency.ts): the I/O lives
 * in the orchestrator; the decision rule lives here as a pure
 * function the test can drive with discrete inputs.
 */
import { describe, expect, it } from 'vitest'
import { shouldEscalateForBudget } from '../per-cut-budget.js'

describe('shouldEscalateForBudget', () => {
  it('returns false when elapsed time is well under budget', () => {
    // 10s into a 45-min cut: nowhere near escalation.
    const result = shouldEscalateForBudget({
      cutStart: 1_000_000,
      now: 1_010_000,
      budget: 45 * 60 * 1000,
    })
    expect(result).toBe(false)
  })

  it('returns false when elapsed time is exactly at the budget (strict-greater-than)', () => {
    // The existing index.ts guard at line 380 uses `>` not `>=`, so
    // hitting the budget exactly should NOT escalate (the next check
    // catches it if time advances). Pinning the boundary explicitly
    // so a future refactor doesn't silently change strictness.
    const budget = 45 * 60 * 1000
    const result = shouldEscalateForBudget({
      cutStart: 0,
      now: budget,
      budget,
    })
    expect(result).toBe(false)
  })

  it('returns true when elapsed time exceeds budget by one ms', () => {
    const budget = 45 * 60 * 1000
    const result = shouldEscalateForBudget({
      cutStart: 0,
      now: budget + 1,
      budget,
    })
    expect(result).toBe(true)
  })

  it('returns true when cut starts late and rapidly exceeds budget', () => {
    // Realistic shape: a thrashing single attempt eats the full budget
    // within one cut. `cutStart` captures when THIS cut began; `now`
    // is just after the attempt finished.
    const result = shouldEscalateForBudget({
      cutStart: 5_000_000,
      now: 5_000_000 + 46 * 60 * 1000,
      budget: 45 * 60 * 1000,
    })
    expect(result).toBe(true)
  })

  it('isolates cuts — same now, different cutStart yields different decisions', () => {
    // THE load-bearing behavior the candidate names. If the helper
    // ignored `cutStart` and anchored on a module-wide constant, both
    // calls would compute the same elapsed and return the same result
    // — defeating per-cut isolation. The two-call shape catches a
    // future regression where someone re-introduces a process-wide
    // anchor (the original #103 bug).
    const now = 10_000_000
    const budget = 45 * 60 * 1000

    // Cut #1 started 50 min ago — over budget.
    const cut1 = shouldEscalateForBudget({
      cutStart: now - 50 * 60 * 1000,
      now,
      budget,
    })

    // Cut #2 started 2 min ago — well under budget, even though
    // cut #1 already burned its full budget.
    const cut2 = shouldEscalateForBudget({
      cutStart: now - 2 * 60 * 1000,
      now,
      budget,
    })

    expect(cut1).toBe(true)
    expect(cut2).toBe(false)
  })
})
