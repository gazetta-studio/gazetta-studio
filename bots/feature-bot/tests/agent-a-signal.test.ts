/**
 * Agent A signal parser tests — failing-test commit per rule 31 TDD-first ordering.
 *
 * Per design-feature-bot.md Q6, Agent A has THREE terminal states emitted
 * as structured blocks in its final assistant text:
 *
 *   - APPROVE_IMPLICIT — commits exist, no signal block
 *   - NEEDS_INPUT block:
 *       NEEDS_INPUT: <one-line question>
 *       Options:
 *         - <option 1 with reasoning>
 *         - <option 2 with reasoning>
 *       Recommendation: <option N because ...>
 *   - NEEDS_HUMAN block:
 *       NEEDS_HUMAN: <one-line reason>
 *       Reason-code: <one of: missing-prereq, spec-too-vague, files-conflict, needs-human>
 *
 * Parser is separate from `reviewer-verdict.ts` (which parses Agent B's
 * APPROVE/REJECT/NEEDS_HUMAN). Different shape, different parser per SRP.
 */
import { describe, expect, it } from 'vitest'
import { parseAgentASignal } from '../agent-a-signal.js'

describe('parseAgentASignal — APPROVE_IMPLICIT path', () => {
  it('returns approve-implicit when no signal block is present', () => {
    const text = 'Done. Committed test + impl on the branch.\n\nSUMMARY:\nAdded redirect route with validation.'
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('approve-implicit')
  })

  it('returns approve-implicit on empty text', () => {
    const result = parseAgentASignal('')
    expect(result.kind).toBe('approve-implicit')
  })

  it('returns approve-implicit when text mentions VERDICT but no Agent A signal', () => {
    // Reviewer verdict markers should NOT trip Agent A's parser.
    const text = 'Working through this... thinking about VERDICT: APPROVE would be wrong here.'
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('approve-implicit')
  })
})

describe('parseAgentASignal — NEEDS_INPUT path', () => {
  it('parses a well-formed NEEDS_INPUT block with options and recommendation', () => {
    const text = `Looked at the spec. Two paths possible.

NEEDS_INPUT: Should the new endpoint return 201 or 200 on idempotent re-creation?
Options:
  - 201 with Location header — REST-idiomatic but breaks existing client retry semantics
  - 200 with body unchanged — matches existing /api/archive behavior
Recommendation: 200 because the existing /api/archive route uses the same shape and operator scripts rely on it.`
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('needs-input')
    if (result.kind === 'needs-input') {
      expect(result.question).toContain('201 or 200')
      expect(result.body).toContain('Options:')
      expect(result.body).toContain('Recommendation:')
    }
  })

  it('treats NEEDS_INPUT without Options as still valid (orchestrator posts verbatim)', () => {
    // Parser is permissive about block contents — Q6 schema is for Agent A
    // to follow; the orchestrator posts the comment verbatim.
    const text = 'NEEDS_INPUT: vague question without options'
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('needs-input')
  })

  it('NEEDS_HUMAN takes precedence when both blocks appear (last wins)', () => {
    // If Agent A confused itself and emitted both, the last block is the
    // committed terminal state — same as reviewer-verdict's last-wins.
    const text = `NEEDS_INPUT: first thought
Options:
  - foo
Recommendation: foo

Actually no.

NEEDS_HUMAN: cut spec is too vague for me to proceed
Reason-code: spec-too-vague`
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('needs-human')
    if (result.kind === 'needs-human') {
      expect(result.reasonCode).toBe('spec-too-vague')
    }
  })
})

describe('parseAgentASignal — NEEDS_HUMAN path', () => {
  it('parses NEEDS_HUMAN with missing-prereq reason-code', () => {
    const text = `Found that the validator framework isn't wired into the route despite #501 being merged.

NEEDS_HUMAN: required validation infrastructure absent from the codebase
Reason-code: missing-prereq`
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('needs-human')
    if (result.kind === 'needs-human') {
      expect(result.reasonCode).toBe('missing-prereq')
      expect(result.reason).toContain('validation infrastructure')
    }
  })

  it('parses NEEDS_HUMAN with spec-too-vague reason-code', () => {
    const text = `NEEDS_HUMAN: the cut sub-issue body has Spec=TBD and no Acceptance items
Reason-code: spec-too-vague`
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('needs-human')
    if (result.kind === 'needs-human') {
      expect(result.reasonCode).toBe('spec-too-vague')
    }
  })

  it('parses NEEDS_HUMAN with files-conflict reason-code', () => {
    const text = `NEEDS_HUMAN: files I would touch are open in PR #890
Reason-code: files-conflict`
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('needs-human')
    if (result.kind === 'needs-human') {
      expect(result.reasonCode).toBe('files-conflict')
    }
  })

  it('defaults reason-code to needs-human when omitted', () => {
    const text = 'NEEDS_HUMAN: generic escalation without explicit code'
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('needs-human')
    if (result.kind === 'needs-human') {
      expect(result.reasonCode).toBe('needs-human')
    }
  })

  it('defaults reason-code to needs-human when Reason-code is malformed', () => {
    const text = `NEEDS_HUMAN: stuck
Reason-code: bogus-not-in-enum`
    const result = parseAgentASignal(text)
    expect(result.kind).toBe('needs-human')
    if (result.kind === 'needs-human') {
      expect(result.reasonCode).toBe('needs-human')
    }
  })
})
