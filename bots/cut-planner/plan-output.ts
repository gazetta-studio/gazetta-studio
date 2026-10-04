/**
 * Plan output — parse and validate Claude's fenced `cut-plan` JSON block.
 *
 * Producer/consumer split per bots/README.md: Claude does the judgement
 * (which cut, how to specify it), TS does the deterministic part (find the
 * block, validate every field, reject anything malformed). A malformed block
 * is NOT guessed past — it comes back as `{ ok: false }` and the orchestrator
 * treats it as "cut-planner could not complete the job" (Q6a).
 *
 * Each mode accepts only the actions that make sense for it, so a refine run
 * cannot answer "file a new cut" and a filing run cannot answer "refine".
 */

export type Mode = 'file' | 'refine' | 'redecompose'

/** The fields that become a cut body. Locks are selected by index (see issue-index.lockBullets). */
export interface CutSpec {
  title: string
  spec: string
  acceptance: string[]
  tests: string[]
  solid: string | null
  lockIndices: number[]
  /** Files the cut is expected to edit. Drives the workflow-file pre-flight (#840). */
  files: string[]
}

export type PlanOutput =
  | ({ action: 'file'; state: string; deviation: string | null } & CutSpec)
  | ({ action: 'refine'; summary: string } & CutSpec)
  | { action: 'redecompose'; first: CutSpec; remaining: string[]; summary: string; state: string }
  | { action: 'needs-input'; question: string; options: string[]; recommendation: string }
  | { action: 'plan-complete'; reason: string }
  | { action: 'design-objection'; reason: string }

const ALLOWED: Record<Mode, readonly PlanOutput['action'][]> = {
  file: ['file', 'needs-input', 'plan-complete'],
  refine: ['refine', 'needs-input', 'design-objection'],
  redecompose: ['redecompose', 'needs-input', 'design-objection'],
}

export type PlanParse = { ok: true; value: PlanOutput } | { ok: false; reason: string }

/** The LAST ```cut-plan fence across the assistant texts — the final answer wins over drafts. */
export function extractPlanBlock(texts: readonly string[]): string | null {
  let last: string | null = null
  for (const t of texts) {
    for (const m of t.matchAll(/```cut-plan\s*\n([\s\S]*?)\n```/g)) last = m[1]
  }
  return last
}

const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

function cutSpec(o: Record<string, unknown>, lockCount: number): CutSpec | string {
  if (!str(o.title)) return 'title missing'
  if (!str(o.spec)) return 'spec missing'
  // The two sections feature-bot's cut-parser REQUIRES — an empty list would
  // be filed and immediately bounced by validateCutSubIssue.
  if (!strArr(o.acceptance) || o.acceptance.filter(str).length === 0)
    return 'acceptance must be a non-empty string array'
  if (!strArr(o.tests) || o.tests.filter(str).length === 0) return 'tests must be a non-empty string array'
  if (o.solid !== null && o.solid !== undefined && typeof o.solid !== 'string') return 'solid must be a string or null'
  const idx = o.lockIndices ?? []
  if (!Array.isArray(idx) || !idx.every(i => Number.isInteger(i) && i >= 0 && i < lockCount)) {
    return `lockIndices must be integers in [0, ${lockCount})`
  }
  if (!strArr(o.files ?? [])) return 'files must be a string array'
  return {
    title: o.title.trim(),
    spec: o.spec,
    acceptance: o.acceptance,
    tests: o.tests,
    solid: typeof o.solid === 'string' && o.solid.trim() !== '' ? o.solid : null,
    lockIndices: [...new Set(idx as number[])],
    files: (o.files as string[] | undefined) ?? [],
  }
}

/**
 * Parse the block for `mode`. `lockCount` is the number of locked-decision
 * bullets on the planner issue; an out-of-range index is rejected rather
 * than clamped, because a bad index means Claude was looking at a different
 * list than the one TS will transcribe from.
 */
export function parsePlanOutput(texts: readonly string[], mode: Mode, lockCount: number): PlanParse {
  const block = extractPlanBlock(texts)
  if (block === null) return { ok: false, reason: 'no ```cut-plan block in the response' }
  let o: unknown
  try {
    o = JSON.parse(block)
  } catch (err) {
    return { ok: false, reason: `cut-plan block is not valid JSON: ${(err as Error).message}` }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o))
    return { ok: false, reason: 'cut-plan block is not an object' }
  const rec = o as Record<string, unknown>
  const action = rec.action
  if (typeof action !== 'string' || !(ALLOWED[mode] as readonly string[]).includes(action)) {
    return { ok: false, reason: `action ${JSON.stringify(action)} is not allowed in ${mode} mode` }
  }

  switch (action) {
    case 'file': {
      const c = cutSpec(rec, lockCount)
      if (typeof c === 'string') return { ok: false, reason: c }
      if (!str(rec.state)) return { ok: false, reason: 'state missing' }
      if (rec.deviation !== null && rec.deviation !== undefined && typeof rec.deviation !== 'string') {
        return { ok: false, reason: 'deviation must be a string or null' }
      }
      const deviation = str(rec.deviation) ? rec.deviation : null
      return { ok: true, value: { action, ...c, state: rec.state, deviation } }
    }
    case 'refine': {
      const c = cutSpec(rec, lockCount)
      if (typeof c === 'string') return { ok: false, reason: c }
      if (!str(rec.summary)) return { ok: false, reason: 'summary missing' }
      return { ok: true, value: { action, ...c, summary: rec.summary } }
    }
    case 'redecompose': {
      if (typeof rec.first !== 'object' || rec.first === null) return { ok: false, reason: 'first missing' }
      const c = cutSpec(rec.first as Record<string, unknown>, lockCount)
      if (typeof c === 'string') return { ok: false, reason: `first: ${c}` }
      // At least one remaining piece — a "split" into one cut is a refinement
      // wearing the wrong label, and would spend the per-feature budget.
      if (!strArr(rec.remaining) || rec.remaining.filter(str).length === 0) {
        return { ok: false, reason: 'remaining must list at least one further cut' }
      }
      if (!str(rec.summary)) return { ok: false, reason: 'summary missing' }
      if (!str(rec.state)) return { ok: false, reason: 'state missing' }
      return {
        ok: true,
        value: { action, first: c, remaining: rec.remaining.filter(str), summary: rec.summary, state: rec.state },
      }
    }
    case 'needs-input': {
      if (!str(rec.question)) return { ok: false, reason: 'question missing' }
      if (!strArr(rec.options) || rec.options.filter(str).length < 2)
        return { ok: false, reason: 'needs at least two options' }
      if (!str(rec.recommendation)) return { ok: false, reason: 'recommendation missing' }
      return {
        ok: true,
        value: { action, question: rec.question, options: rec.options.filter(str), recommendation: rec.recommendation },
      }
    }
    case 'plan-complete':
    case 'design-objection': {
      if (!str(rec.reason)) return { ok: false, reason: 'reason missing' }
      return { ok: true, value: { action, reason: rec.reason } }
    }
  }
  return { ok: false, reason: 'unreachable' }
}

/** True when any expected edit touches a workflow file — undeliverable by GITHUB_TOKEN (#840). */
export function touchesWorkflows(files: readonly string[]): boolean {
  return files.some(f => /(^|\/)\.github\/workflows\//.test(f.replace(/^\.\//, '')))
}
