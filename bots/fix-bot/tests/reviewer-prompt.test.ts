import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Structural smoke tests on the reviewer prompt — catches accidental
// removal of load-bearing sections. We don't test Claude's behavior;
// we test that the prompt still contains the contracts it promises
// downstream tooling. Per design-code-review-implementation.md Cut 11.

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, '..', 'prompts', 'reviewer.md')
const prompt = readFileSync(PROMPT_PATH, 'utf-8')

describe('fix-bot reviewer prompt — structural contracts', () => {
  it('keeps the four-step runtime tautology check', () => {
    expect(prompt).toMatch(/## The tautology check/)
    expect(prompt).toMatch(/### Step 1: confirm both commits exist/)
    expect(prompt).toMatch(/### Step 2: revert the fix commit/)
    expect(prompt).toMatch(/### Step 3: verify the failure matches/)
    expect(prompt).toMatch(/### Step 4: re-apply the fix/)
  })

  it('keeps the non-mechanical checks (Step 2 in Process)', () => {
    expect(prompt).toMatch(/### Wrong root cause/)
    expect(prompt).toMatch(/### Scope creep/)
    expect(prompt).toMatch(/### Commit message accuracy/)
  })

  it('invokes review-architecture skill in Step 3 (replaces previous project-rule check)', () => {
    expect(prompt).toMatch(/## The architecture-review check \(Step 3\)/)
    expect(prompt).toMatch(/Skill: review-architecture/)
  })

  it('conditionally invokes review-security skill in Step 3', () => {
    expect(prompt).toMatch(/Skill: review-security/)
    expect(prompt).toMatch(/security-sensitive path/)
  })

  it('documents the severity-to-verdict action policy table', () => {
    expect(prompt).toMatch(/Action policy for skill findings/)
    expect(prompt).toMatch(/CRITICAL/)
    expect(prompt).toMatch(/IMPORTANT/)
    expect(prompt).toMatch(/NIT/)
  })

  it('keeps the VERDICT line contract (parseable by reviewer-verdict.ts)', () => {
    expect(prompt).toMatch(/VERDICT: APPROVE/)
    expect(prompt).toMatch(/VERDICT: REJECT/)
    expect(prompt).toMatch(/VERDICT: NEEDS_HUMAN/)
  })

  it('keeps the Process list with five steps', () => {
    // Process section enumerates the steps the reviewer follows.
    // Should be five numbered items: tautology / non-mechanical /
    // skill invocations / form verdict / emit VERDICT line.
    const processMatch = prompt.match(/## Process\n\n([\s\S]+?)(?=\n##|\n```)/)
    expect(processMatch, 'Process section missing').toBeTruthy()
    const body = processMatch![1]
    // Count numbered list items at the start of lines.
    const numbered = body.split('\n').filter(l => /^\d+\.\s/.test(l))
    expect(numbered).toHaveLength(5)
  })

  it('does NOT contain the old project-rule check section header', () => {
    // Step 3 was renamed from "project-rule check" to "architecture-review
    // check." If the old section header reappears, someone reverted the
    // Cut 11 change.
    expect(prompt).not.toMatch(/## The project-rule check/)
  })

  it('declares Skill tool as needed (documented in prose)', () => {
    expect(prompt).toMatch(/via the `Skill` tool/)
  })
})
