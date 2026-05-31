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

  it('delegates review-architecture to a subagent in Step 4 (replaces previous project-rule check)', () => {
    // Step 4 (numbered after mode + runtime-exercise was added in Step 2).
    // Spawned via Agent tool, not invoked directly via Skill — keeps the
    // skill's heavy context out of Agent B's window so the findings
    // fence doesn't read as a natural terminator. See #469 + follow-up.
    expect(prompt).toMatch(/## The architecture-review check \(Step 4\)/)
    expect(prompt).toMatch(/review-architecture/)
    expect(prompt).toMatch(/Agent\(\{/)
  })

  it('conditionally spawns review-security subagent in Step 4', () => {
    expect(prompt).toMatch(/review-security/)
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

  it('keeps the Process list with six steps', () => {
    // Process section enumerates the steps the reviewer follows.
    // Six numbered items: tautology / mode+runtime-exercise /
    // non-mechanical / skill invocations / form verdict / emit VERDICT.
    // (Mode + runtime-exercise added per fix-bot runtime-exercise
    // discipline mirroring feature-bot's #455 — runtime exercise proves
    // the fix works on every fix-touched path; without it, "tests pass"
    // can be tautological.)
    const processMatch = prompt.match(/## Process\n\n([\s\S]+?)(?=\n##|\n```)/)
    expect(processMatch, 'Process section missing').toBeTruthy()
    const body = processMatch![1]
    // Count numbered list items at the start of lines.
    const numbered = body.split('\n').filter(l => /^\d+\.\s/.test(l))
    expect(numbered).toHaveLength(6)
  })

  it('does NOT contain the old project-rule check section header', () => {
    // Step 3 was renamed from "project-rule check" to "architecture-review
    // check." If the old section header reappears, someone reverted the
    // Cut 11 change.
    expect(prompt).not.toMatch(/## The project-rule check/)
  })

  it('declares Agent tool as needed (documented in prose)', () => {
    // Reviewer spawns subagents via the Agent tool for review-architecture
    // and review-security; this isolates the skills' heavy context from
    // Agent B's window so the findings fence doesn't pull Agent B toward
    // early termination before emitting VERDICT. See #469 + follow-up.
    expect(prompt).toMatch(/via the `Agent`\s*\n?\s*tool/)
  })
})
