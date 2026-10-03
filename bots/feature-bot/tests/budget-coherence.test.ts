/**
 * The three feature-bot budget knobs plus the workflow wall must form a
 * coherent ladder:
 *
 *     per-attempt slice  <  PER_CUT_BUDGET_MS  <  PER_RUN_BUDGET_MS  <  timeout-minutes
 *
 * Each inequality has a reason, and each was violated before 2026-10-03:
 *
 *  - **slice < per-cut**: with MAX_ATTEMPTS=5 sharing a 45-min cut budget,
 *    one generator-critic round got ~9 minutes — while a single Agent A
 *    invocation was MEASURED at 638s (~10.6 min) on cut #524 (run
 *    37150215338). One attempt could not fit its own slice, so every
 *    substantive cut escalated on budget regardless of quality.
 *
 *  - **per-cut < per-run**: the per-RUN guard fires at the top of the
 *    candidate loop, so it bounds how many CUTS a run attempts and never
 *    interrupts one in flight. If per-cut (120) exceeded per-run (50), a
 *    cut would blow the run budget *by design* and the "stopping with N
 *    unprocessed" path would fire on every substantive cut instead of
 *    exceptionally.
 *
 *  - **per-run < wall**: the whole point of the in-bot budgets is to
 *    convert the workflow's silent mid-attempt hard-kill (the #516 failure
 *    mode: no PR, no escalation, no record) into a graceful NEEDS_HUMAN
 *    escalation. If the wall came first, the graceful path would be
 *    unreachable.
 *
 * Also pinned: the workflow's fallback literals must equal the TypeScript
 * defaults. The workflow comment already states this requirement ("MUST
 * match the TypeScript defaults"), but nothing enforced it — so the two
 * could drift silently, and a manual dispatch with no inputs would then
 * run different numbers than the cron.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_SRC = readFileSync(resolve(HERE, '..', 'index.ts'), 'utf-8')
const WORKFLOW_SRC = readFileSync(resolve(HERE, '..', '..', '..', '.github', 'workflows', 'feature-bot.yml'), 'utf-8')

/** Pull a `const NAME = Number(process.env.X ?? <expr>)` default out of index.ts. */
function tsDefault(name: string): number {
  const m = INDEX_SRC.match(new RegExp(`const ${name} = Number\\(process\\.env\\.\\w+ \\?\\? (.+?)\\)`))
  if (!m) throw new Error(`could not find TS default for ${name}`)
  // The expression is either a number literal, a quoted number, or an
  // arithmetic product like `120 * 60 * 1000`.
  const expr = m[1].replace(/['"]/g, '').trim()
  const parts = expr.split('*').map(p => Number(p.trim()))
  if (parts.some(Number.isNaN)) throw new Error(`unparseable default for ${name}: ${expr}`)
  return parts.reduce((a, b) => a * b, 1)
}

/** Pull a `NAME: ${{ inputs.x || 'N' }}` fallback literal out of the workflow. */
function workflowFallback(name: string): number {
  const m = WORKFLOW_SRC.match(new RegExp(`${name}: \\$\\{\\{ inputs\\.\\w+ \\|\\| '(\\d+)' \\}\\}`))
  if (!m) throw new Error(`could not find workflow fallback for ${name}`)
  return Number(m[1])
}

function workflowTimeoutMs(): number {
  const m = WORKFLOW_SRC.match(/timeout-minutes: (\d+)/)
  if (!m) throw new Error('could not find timeout-minutes')
  return Number(m[1]) * 60 * 1000
}

describe('feature-bot budget ladder', () => {
  const perRun = tsDefault('PER_RUN_BUDGET_MS')
  const perCut = tsDefault('PER_CUT_BUDGET_MS')
  const maxAttempts = tsDefault('MAX_ATTEMPTS')
  const wall = workflowTimeoutMs()

  it('allows a per-attempt slice bigger than one measured Agent A invocation', () => {
    // Agent A measured at 638s on cut #524. A slice must comfortably
    // exceed that, since a full attempt is Agent A *plus* Agent B.
    const MEASURED_AGENT_A_MS = 638 * 1000
    const slice = perCut / maxAttempts
    expect(slice).toBeGreaterThan(MEASURED_AGENT_A_MS * 2)
  })

  it('keeps per-cut below per-run (per-run never interrupts a cut in flight)', () => {
    expect(perCut).toBeLessThan(perRun)
  })

  it('keeps per-run below the workflow wall (graceful escalation beats hard kill)', () => {
    expect(perRun).toBeLessThan(wall)
  })

  it('matches the workflow fallback literals to the TypeScript defaults', () => {
    expect(workflowFallback('MAX_ATTEMPTS')).toBe(maxAttempts)
    expect(workflowFallback('BUDGET_MS')).toBe(perRun)
    expect(workflowFallback('CUT_BUDGET_MS')).toBe(perCut)
  })
})
