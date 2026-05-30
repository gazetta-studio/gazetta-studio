/**
 * Orchestrator parse + dep-validation tests — failing-test commit per
 * rule 31 TDD-first ordering.
 *
 * These tests cover the orchestrator's PRE-CLAUDE gate: parse the cut
 * sub-issue body, validate referenced deps against the live issue tree,
 * loud-fail on bad refs without invoking Claude.
 *
 * Per design-feature-bot.md Q3:
 *   - body with missing **Feature** → comment + needs-info label
 *   - body with missing required section → comment + needs-info label
 *   - self-reference → ready-for-human + skip-list entry (spec-too-vague)
 *   - dep number doesn't exist → comment + needs-info label
 *   - dep issue not labeled `enhancement` → same as not-found
 *   - dep open → comment "wait for dep" + NO labels applied
 *   - dep closed-not-merged → ready-for-human + skip-list entry
 *   - all deps closed-merged → proceed
 *
 * The orchestrator is mocked here at the seam — we test the validate
 * function directly, which the orchestrator dispatches to before
 * invoking Claude. No real GitHub access; octokit is mocked.
 */
import { describe, expect, it, vi } from 'vitest'
import { validateCutSubIssue, type CutValidationResult } from '../validate-cut-sub-issue.js'

// Minimal octokit-shaped mock. Each test wires its own per-issue handler.
type FakeIssue = {
  number: number
  state: 'open' | 'closed'
  state_reason?: 'completed' | 'not_planned' | 'reopened' | null
  labels: Array<string | { name?: string }>
  pull_request?: { merged_at?: string | null }
}

function makeOctokit(issuesByNumber: Record<number, FakeIssue | 'not-found'>) {
  return {
    issues: {
      get: vi.fn(async ({ issue_number }: { issue_number: number }) => {
        const issue = issuesByNumber[issue_number]
        if (!issue || issue === 'not-found') {
          const err: Error & { status?: number } = new Error('Not Found')
          err.status = 404
          throw err
        }
        return { data: issue }
      }),
    },
  }
}

const REPO = { owner: 'gazetta-studio', repo: 'gazetta-studio' }

describe('validateCutSubIssue — body-level errors', () => {
  it('reports body-error when **Feature** field is missing', async () => {
    const body = `## Spec
do the thing

## Acceptance
- it works

## Tests
- bots/feature-bot/tests/foo.test.ts`
    const octokit = makeOctokit({})
    const result = await validateCutSubIssue(octokit as never, REPO, 500, body)
    expect(result.kind).toBe('body-error')
    if (result.kind === 'body-error') {
      expect(result.errors.some(e => e.kind === 'missing-feature')).toBe(true)
    }
    expect(octokit.issues.get).not.toHaveBeenCalled()
  })

  it('reports body-error when ## Spec section is missing', async () => {
    const body = `**Feature**: redirect-ui

## Acceptance
- it works

## Tests
- bots/feature-bot/tests/foo.test.ts`
    const octokit = makeOctokit({})
    const result = await validateCutSubIssue(octokit as never, REPO, 500, body)
    expect(result.kind).toBe('body-error')
    if (result.kind === 'body-error') {
      expect(result.errors.some(e => e.kind === 'missing-required-section')).toBe(true)
    }
  })

  it('reports body-error when ## Acceptance section is missing', async () => {
    const body = `**Feature**: redirect-ui

## Spec
do the thing

## Tests
- bots/feature-bot/tests/foo.test.ts`
    const octokit = makeOctokit({})
    const result = await validateCutSubIssue(octokit as never, REPO, 500, body)
    expect(result.kind).toBe('body-error')
  })

  it('reports body-error when ## Tests section is missing', async () => {
    const body = `**Feature**: redirect-ui

## Spec
do the thing

## Acceptance
- it works`
    const octokit = makeOctokit({})
    const result = await validateCutSubIssue(octokit as never, REPO, 500, body)
    expect(result.kind).toBe('body-error')
  })

  it('reports self-reference as spec-too-vague (skip-list entry)', async () => {
    const body = `**Feature**: redirect-ui
**Depends on**: #500

## Spec
do the thing

## Acceptance
- it works

## Tests
- foo.test.ts`
    const octokit = makeOctokit({})
    const result = await validateCutSubIssue(octokit as never, REPO, 500, body)
    expect(result.kind).toBe('self-reference')
  })
})

describe('validateCutSubIssue — dependency validation', () => {
  function validBody(deps: string): string {
    return `**Feature**: redirect-ui
**Depends on**: ${deps}

## Spec
do the thing

## Acceptance
- it works

## Tests
- bots/feature-bot/tests/foo.test.ts`
  }

  it('returns ready when all deps are closed-merged', async () => {
    const octokit = makeOctokit({
      501: {
        number: 501,
        state: 'closed',
        state_reason: 'completed',
        labels: ['enhancement', 'ready-for-agent'],
      },
      502: {
        number: 502,
        state: 'closed',
        state_reason: 'completed',
        labels: ['enhancement', 'ready-for-agent'],
      },
    })
    const result = await validateCutSubIssue(octokit as never, REPO, 503, validBody('#501, #502'))
    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.parsed.feature).toBe('redirect-ui')
      expect(result.parsed.dependsOn).toEqual([501, 502])
    }
  })

  it('returns ready when there are no deps', async () => {
    const octokit = makeOctokit({})
    const result = await validateCutSubIssue(octokit as never, REPO, 503, validBody('none'))
    expect(result.kind).toBe('ready')
    expect(octokit.issues.get).not.toHaveBeenCalled()
  })

  it('returns dep-open when any dep is still open (no labels applied)', async () => {
    const octokit = makeOctokit({
      501: {
        number: 501,
        state: 'open',
        labels: ['enhancement', 'ready-for-agent'],
      },
    })
    const result = await validateCutSubIssue(octokit as never, REPO, 503, validBody('#501'))
    expect(result.kind).toBe('dep-open')
    if (result.kind === 'dep-open') {
      expect(result.openDeps).toContain(501)
    }
  })

  it('returns dep-rejected when dep is closed-not-merged', async () => {
    const octokit = makeOctokit({
      501: {
        number: 501,
        state: 'closed',
        state_reason: 'not_planned',
        labels: ['enhancement', 'ready-for-agent'],
      },
    })
    const result = await validateCutSubIssue(octokit as never, REPO, 503, validBody('#501'))
    expect(result.kind).toBe('dep-rejected')
  })

  it('returns dep-invalid when dep number does not exist', async () => {
    const octokit = makeOctokit({
      501: 'not-found',
    })
    const result = await validateCutSubIssue(octokit as never, REPO, 503, validBody('#501'))
    expect(result.kind).toBe('dep-invalid')
  })

  it('returns dep-invalid when dep lacks the enhancement label', async () => {
    const octokit = makeOctokit({
      501: {
        number: 501,
        state: 'closed',
        state_reason: 'completed',
        labels: ['bug', 'ready-for-agent'], // bug, not enhancement
      },
    })
    const result = await validateCutSubIssue(octokit as never, REPO, 503, validBody('#501'))
    expect(result.kind).toBe('dep-invalid')
  })

  it('aggregates errors when one dep is open AND another is invalid', async () => {
    // The orchestrator should not invoke Claude when ANY dep fails.
    // Open-dep wins over invalid-dep here? Actually both should be reported,
    // but the orchestrator action is determined by the most-blocking error.
    // dep-invalid is more terminal (needs-info / ready-for-human) than
    // dep-open (just wait). So when both present, return dep-invalid.
    const octokit = makeOctokit({
      501: {
        number: 501,
        state: 'open',
        labels: ['enhancement', 'ready-for-agent'],
      },
      502: 'not-found',
    })
    const result: CutValidationResult = await validateCutSubIssue(octokit as never, REPO, 503, validBody('#501, #502'))
    // dep-invalid is more terminal; orchestrator returns the worse error first.
    expect(result.kind).toBe('dep-invalid')
  })
})
