/**
 * Pure pieces of `compact.ts`, extracted so the load-bearing branches are
 * tested without spawning Claude. Same split as fix-bot's compact-helpers.
 */
import type { DecisionLogEntry } from './decision-log.js'

export type GateOutcome =
  | { run: false; reason: 'below-threshold'; signal: number; threshold: number }
  | { run: false; reason: 'dry-run' }
  | { run: true }

/**
 * Whether there is enough signal to rewrite lessons.
 *
 * Signal = runs that TOOK AN ACTION. Idle, quota-stop and budget-stop runs
 * say nothing about how cuts are specified (the compact prompt's rule 4),
 * so counting them would let a month of rate-limited runs trigger a rewrite
 * built on no evidence. Threshold before dry-run, so a dry run below
 * threshold still reports "not enough signal" — the honest answer to
 * "would this have invoked Claude?".
 */
export function shouldCompact(log: readonly DecisionLogEntry[], threshold: number, dryRun: boolean): GateOutcome {
  const signal = log.filter(e => e.outcome === 'acted').length
  if (signal < threshold) return { run: false, reason: 'below-threshold', signal, threshold }
  if (dryRun) return { run: false, reason: 'dry-run' }
  return { run: true }
}

export function composeCompactPrompt(o: {
  template: string
  lessonsPath: string
  log: readonly DecisionLogEntry[]
  previousLessons: string
  runId: string
}): string {
  return `${o.template}

LESSONS_PATH=${o.lessonsPath}
RUN_ID=${o.runId}
DECISION_LOG_JSON=${JSON.stringify(o.log, null, 2)}
PREVIOUS_LESSONS=
${o.previousLessons}`
}
