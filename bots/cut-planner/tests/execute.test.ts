/**
 * Executor tests — every decision path against in-memory ports.
 *
 * The fake GitHub records each write in order, so the tests can pin the
 * write ORDER (durable log before derived state; add-label before
 * remove-label) as well as the end state. Those orderings are what keep an
 * interrupted, non-transactional run recoverable.
 */
import { describe, expect, it } from 'vitest'
import type { RunDecision } from '../dispatch-run.js'
import {
  executeDecision,
  executeSafely,
  type FeatureContext,
  type GitHubPort,
  type PlannerPort,
  type PlannerResult,
} from '../execute.js'
import { featureBotHandoffMarker, redecomposedMarker, refinedMarker } from '../markers.js'
import type { Mode } from '../plan-output.js'

class FakeGitHub implements GitHubPort {
  log: string[] = []
  issues = new Map<number, { title: string; body: string; labels: string[]; closed?: string }>()
  comments = new Map<number, string[]>()
  next = 100
  failOn: string | null = null

  private w(entry: string) {
    if (this.failOn && entry.startsWith(this.failOn)) throw new Error(`boom on ${entry}`)
    this.log.push(entry)
  }
  async getIssue(n: number) {
    const i = this.issues.get(n)
    if (!i) throw new Error(`no #${n}`)
    return i
  }
  async listCommentBodies(n: number) {
    return this.comments.get(n) ?? []
  }
  async createIssue(title: string, body: string, labels: readonly string[]) {
    const n = this.next++
    this.w(`create #${n}`)
    this.issues.set(n, { title, body, labels: [...labels] })
    return n
  }
  async updateBody(n: number, body: string) {
    this.w(`body #${n}`)
    this.issues.get(n)!.body = body
  }
  async comment(n: number, body: string) {
    this.w(`comment #${n}`)
    this.comments.set(n, [...(this.comments.get(n) ?? []), body])
  }
  async addLabel(n: number, l: string) {
    this.w(`+${l} #${n}`)
    this.issues.get(n)!.labels.push(l)
  }
  async removeLabel(n: number, l: string) {
    this.w(`-${l} #${n}`)
    const i = this.issues.get(n)!
    i.labels = i.labels.filter(x => x !== l)
  }
  async close(n: number, reason: 'completed' | 'not_planned') {
    this.w(`close #${n}`)
    this.issues.get(n)!.closed = reason
  }
}

const plannerReturning = (result: PlannerResult): PlannerPort & { modes: Mode[] } => {
  const modes: Mode[] = []
  return { modes, plan: async mode => (modes.push(mode), result) }
}
const answer = (o: unknown): PlannerResult => ({ kind: 'ok', texts: [`\`\`\`cut-plan\n${JSON.stringify(o)}\n\`\`\``] })

const PLANNER_BODY =
  '**Feature**: rw\n**Design**: d.md\n\n## Suggested plan\n\n| 5 | gate |\n\n## State\n\nNext: cut 5\n\n## Locked decisions\n\n- use computeSaveEtag (#837)'
const ctx = (): FeatureContext => ({
  planner: {
    feature: 'rw',
    designPath: 'd.md',
    suggestedPlan: '| 5 | gate |',
    state: 'Next: cut 5',
    lockedDecisions: '- use computeSaveEtag (#837)',
  },
  plannerIssueNumber: 1,
  plannerBody: PLANNER_BODY,
  areaLabels: ['area: cms'],
  runId: 'r1',
})
const spec = {
  title: 'gate saves',
  spec: 'Reject saves while pending-review.',
  acceptance: ['409 EDIT_LOCKED'],
  tests: ['tests/save-lock.test.ts'],
  solid: null,
  lockIndices: [0],
  files: ['packages/gazetta/src/manifest-save.ts'],
}
const setup = () => {
  const gh = new FakeGitHub()
  gh.issues.set(1, { title: 'planner', body: PLANNER_BODY, labels: ['enhancement', 'area: cms'] })
  return gh
}

describe('file-next', () => {
  it('files a queued cut, logs the decision, then rewrites ## State — in that order', async () => {
    const gh = setup()
    const out = await executeDecision(
      { kind: 'file-next' },
      ctx(),
      gh,
      plannerReturning(answer({ action: 'file', ...spec, state: 'In flight: #100', deviation: null })),
    )

    expect(out).toEqual({ kind: 'acted', summary: 'filed #100' })
    expect(gh.log).toEqual(['create #100', 'comment #1', 'body #1'])
    const cut = gh.issues.get(100)!
    expect(cut.title).toBe('rw: gate saves')
    expect(cut.labels).toEqual(['enhancement', 'area: cms', 'ready-for-agent'])
    // Q2: the lock is transcribed verbatim from the planner, selected by index.
    expect(cut.body).toContain('use computeSaveEtag (#837)')
    expect(gh.issues.get(1)!.body).toContain('## State\n\nIn flight: #100')
  })

  it('records a workflow-touching cut but never queues it (#840)', async () => {
    const gh = setup()
    await executeDecision(
      { kind: 'file-next' },
      ctx(),
      gh,
      plannerReturning(
        answer({ action: 'file', ...spec, files: ['.github/workflows/ci.yml'], state: 's', deviation: null }),
      ),
    )

    expect(gh.issues.get(100)!.labels).toEqual(['enhancement', 'area: cms', 'ready-for-human'])
    expect(gh.comments.get(100)![0]).toContain('cannot modify workflow files')
  })

  it('logs a recorded deviation from the suggested plan (Q3)', async () => {
    const gh = setup()
    await executeDecision(
      { kind: 'file-next' },
      ctx(),
      gh,
      plannerReturning(answer({ action: 'file', ...spec, state: 's', deviation: 'folded cut 6 into 5' })),
    )
    expect(gh.comments.get(1)![0]).toContain('> Decision: deviated from the suggested plan — folded cut 6 into 5')
  })

  it('asks a design question instead of inventing an answer (Q2)', async () => {
    const gh = setup()
    await executeDecision(
      { kind: 'file-next' },
      ctx(),
      gh,
      plannerReturning(answer({ action: 'needs-input', question: 'q?', options: ['a', 'b'], recommendation: 'a' })),
    )
    expect(gh.log).toEqual(['comment #1', '+needs-info #1'])
    expect(gh.issues.size).toBe(1)
  })

  it('escalates the FEATURE when the answer is unusable', async () => {
    const gh = setup()
    await executeDecision({ kind: 'file-next' }, ctx(), gh, plannerReturning({ kind: 'ok', texts: ['no fence'] }))
    expect(gh.log).toEqual(['comment #1', '+needs-info #1'])
    expect(gh.comments.get(1)![0]).toContain('planning-failed')
  })
})

describe('quota is never an escalation (Q6a carve-out)', () => {
  it.each<RunDecision>([
    { kind: 'file-next' },
    { kind: 'refine', issueNumber: 7, priorRefinements: 0 },
    { kind: 'redecompose', issueNumber: 7 },
  ])('%j writes nothing and stops the queue', async decision => {
    const gh = setup()
    gh.issues.set(7, { title: 'c', body: 'b', labels: ['enhancement', 'needs-refinement'] })
    const out = await executeDecision(decision, ctx(), gh, plannerReturning({ kind: 'quota' }))
    expect(out).toEqual({ kind: 'quota-stop' })
    expect(gh.log).toEqual([])
  })
})

describe('refine', () => {
  const withCut = () => {
    const gh = setup()
    gh.issues.set(7, { title: 'rw: gate', body: 'old body', labels: ['enhancement', 'area: cms', 'needs-refinement'] })
    gh.comments.set(7, [
      `older <!-- ${featureBotHandoffMarker(7)} -->`,
      `Architecture gap at manifest-save.ts:329 <!-- ${featureBotHandoffMarker(7)} -->`,
    ])
    return gh
  }

  it('hands the LATEST reviewer verdict to the planner', async () => {
    const gh = withCut()
    let seen: string | null = null
    await executeDecision({ kind: 'refine', issueNumber: 7, priorRefinements: 0 }, ctx(), gh, {
      plan: async (_m, c) => (
        (seen = c.cut?.reviewerNote ?? null), answer({ action: 'refine', ...spec, summary: 's' })
      ),
    })
    expect(seen).toContain('Architecture gap at manifest-save.ts:329')
  })

  it('rewrites the body, tags the refinement, and swaps labels add-before-remove', async () => {
    const gh = withCut()
    await executeDecision(
      { kind: 'refine', issueNumber: 7, priorRefinements: 0 },
      ctx(),
      gh,
      plannerReturning(answer({ action: 'refine', ...spec, summary: 'named the target file' })),
    )

    expect(gh.log).toEqual(['body #7', 'comment #7', '+ready-for-agent #7', '-needs-refinement #7', 'comment #1'])
    expect(gh.issues.get(7)!.labels).toEqual(['enhancement', 'area: cms', 'ready-for-agent'])
    // The tag is what the next run counts against the refinement budget.
    expect(gh.comments.get(7)!.at(-1)).toContain(refinedMarker(7))
  })

  it('escalates the CUT on a design objection — a spec rewrite cannot answer it', async () => {
    const gh = withCut()
    await executeDecision(
      { kind: 'refine', issueNumber: 7, priorRefinements: 0 },
      ctx(),
      gh,
      plannerReturning(answer({ action: 'design-objection', reason: 'wrong layer' })),
    )
    expect(gh.log).toEqual(['comment #7', '+ready-for-human #7', '-needs-refinement #7'])
  })
})

describe('redecompose', () => {
  it('files the first piece, closes the original, and logs the per-feature counter', async () => {
    const gh = setup()
    gh.issues.set(7, { title: 'rw: big', body: 'b', labels: ['enhancement', 'needs-refinement'] })
    const out = await executeDecision(
      { kind: 'redecompose', issueNumber: 7 },
      ctx(),
      gh,
      plannerReturning(
        answer({
          action: 'redecompose',
          first: spec,
          remaining: ['part b'],
          summary: 'too broad',
          state: 'Next: part b',
        }),
      ),
    )

    expect(out).toEqual({ kind: 'acted', summary: 're-decomposed #7 → #100' })
    expect(gh.log).toEqual(['create #100', 'comment #7', '-needs-refinement #7', 'close #7', 'comment #1', 'body #1'])
    expect(gh.issues.get(7)!.closed).toBe('not_planned')
    expect(gh.comments.get(1)![0]).toContain(redecomposedMarker('rw'))
    expect(gh.comments.get(1)![0]).toContain('- part b')
  })
})

describe('terminal decisions', () => {
  it('escalate-cut labels the cut ready-for-human and leaves the feature running', async () => {
    const gh = setup()
    gh.issues.set(7, { title: 'c', body: 'b', labels: ['enhancement', 'needs-refinement'] })
    await executeDecision(
      { kind: 'escalate-cut', issueNumber: 7, reason: 'redecomposition-failed' },
      ctx(),
      gh,
      plannerReturning({ kind: 'quota' }),
    )
    expect(gh.log).toEqual(['comment #7', '+ready-for-human #7', '-needs-refinement #7'])
    expect(gh.issues.get(1)!.labels).not.toContain('needs-info')
  })

  it('escalate-feature labels the PLANNER needs-info', async () => {
    const gh = setup()
    await executeDecision(
      { kind: 'escalate-feature', reason: 'plan-exhausted' },
      ctx(),
      gh,
      plannerReturning({ kind: 'quota' }),
    )
    expect(gh.log).toEqual(['comment #1', '+needs-info #1'])
  })

  it('idle writes nothing and never calls the planner', async () => {
    const gh = setup()
    const p = plannerReturning({ kind: 'quota' })
    expect(await executeDecision({ kind: 'idle', because: 'cut-in-flight' }, ctx(), gh, p)).toEqual({ kind: 'idle' })
    expect(gh.log).toEqual([])
    expect(p.modes).toEqual([])
  })
})

describe('executeSafely — the Q6a default', () => {
  it('escalates the feature when a write throws mid-action', async () => {
    const gh = setup()
    gh.failOn = 'body #1'
    const out = await executeSafely(
      { kind: 'file-next' },
      ctx(),
      gh,
      plannerReturning(answer({ action: 'file', ...spec, state: 's', deviation: null })),
    )
    expect(out.kind).toBe('acted')
    expect(gh.issues.get(1)!.labels).toContain('needs-info')
    expect(gh.comments.get(1)!.at(-1)).toContain('unexpected-error')
  })

  it('escalates the CUT when the failing decision names one', async () => {
    const gh = setup()
    gh.issues.set(7, { title: 'c', body: 'b', labels: ['enhancement', 'needs-refinement'] })
    gh.failOn = 'body #7'
    await executeSafely(
      { kind: 'refine', issueNumber: 7, priorRefinements: 0 },
      ctx(),
      gh,
      plannerReturning(answer({ action: 'refine', ...spec, summary: 's' })),
    )
    expect(gh.issues.get(7)!.labels).toContain('ready-for-human')
  })

  it('rethrows when even the escalation cannot be written', async () => {
    const gh = setup()
    gh.failOn = 'comment #1'
    await expect(
      executeSafely(
        { kind: 'escalate-feature', reason: 'plan-exhausted' },
        ctx(),
        gh,
        plannerReturning({ kind: 'quota' }),
      ),
    ).rejects.toThrow('boom')
  })
})
