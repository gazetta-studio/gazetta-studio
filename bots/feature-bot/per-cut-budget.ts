/**
 * Per-cut budget guard — pure decision rule.
 *
 * The orchestrator captures `cutStart = Date.now()` at the top of
 * `fixOneCut()` and calls this helper before each generator-critic
 * attempt to decide whether to escalate. Anchoring on `cutStart`
 * (not a module-level constant) ensures cut #2 in a cron run does
 * NOT inherit cut #1's elapsed time. The earlier shape — a module
 * `const PROCESS_START = Date.now()` — meant a multi-cut run could
 * escalate cut #2 prematurely after cut #1 had already burned the
 * budget.
 *
 * Strict-greater-than matches the prior `index.ts:380` guard
 * (`cutElapsed > PER_CUT_BUDGET_MS`): hitting the budget exactly
 * is not yet escalation; the next check catches it once time
 * advances by one ms. Documented as a behavior contract in the
 * tests so a future refactor doesn't silently flip strictness.
 *
 * Pure function so the rule can be tested without mocking time,
 * mirroring `decideIdempotency`'s split (rule 18 SOLID at module
 * creation: I/O in the orchestrator, decision rule here).
 */

export interface PerCutBudgetInput {
  /** ms timestamp when THIS cut began (captured at fixOneCut entry). */
  cutStart: number
  /** ms timestamp for the current decision point (typically Date.now()). */
  now: number
  /** ms wall-clock allowance for one cut before escalation fires. */
  budget: number
}

export function shouldEscalateForBudget(input: PerCutBudgetInput): boolean {
  const elapsed = input.now - input.cutStart
  return elapsed > input.budget
}
