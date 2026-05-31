import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Structural smoke tests on feature-bot's reviewer prompt — catches
// accidental removal of load-bearing sections. We don't test Claude's
// behavior; we test that the prompt still contains the contracts it
// promises downstream tooling. Mirror of fix-bot's reviewer-prompt
// structural test (`bots/fix-bot/tests/reviewer-prompt.test.ts`).

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(__dirname, '..', 'prompts', 'reviewer.md')
const prompt = readFileSync(PROMPT_PATH, 'utf-8')

describe('feature-bot reviewer prompt — structural contracts', () => {
  it('keeps the four-step tautology check', () => {
    expect(prompt).toMatch(/### Step 1: confirm both commits exist/)
    expect(prompt).toMatch(/### Step 2: revert the impl commit/)
    expect(prompt).toMatch(/### Step 3: verify the failure matches/)
    expect(prompt).toMatch(/### Step 4: re-apply/)
  })

  it('keeps the acceptance + runtime-exercise + SOLID + locked-decisions sections', () => {
    expect(prompt).toMatch(/## The acceptance check/)
    expect(prompt).toMatch(/## The runtime-exercise check/)
    expect(prompt).toMatch(/## The SOLID check/)
    expect(prompt).toMatch(/## The locked-decisions check/)
  })

  it('delegates review-architecture to a subagent', () => {
    // The Skill tool (used DIRECTLY) loads heavy context into Agent B's
    // window and pulls Agent B toward early termination (fix-bot's #469
    // failure mode). Subagent delegation isolates the skill's context.
    expect(prompt).toMatch(/## The architecture-review check/)
    expect(prompt).toMatch(/review-architecture/)
    expect(prompt).toMatch(/Agent\(\{/)
  })

  it('conditionally spawns review-security subagent for security-sensitive paths', () => {
    expect(prompt).toMatch(/review-security/)
    expect(prompt).toMatch(/security-sensitive path/)
  })

  it('documents sequential (not parallel) subagent spawning', () => {
    // The tautology check (step 1) mutates the working tree (git revert
    // + git reset). Sub-skills must not race with each other or the main
    // flow on tree state — sequential keeps "at most one subagent
    // touches the tree at a time" as the invariant.
    expect(prompt).toMatch(/SEQUENTIALLY|sequential/)
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

  it('keeps the Process list with eight steps', () => {
    // Eight numbered items: tautology / acceptance / runtime-exercise /
    // SOLID / locked-decisions / non-mechanical / spawn-subagents /
    // form-verdict.
    const processMatch = prompt.match(/## Process\n\n([\s\S]+?)(?=\n##|\n```)/)
    expect(processMatch, 'Process section missing').toBeTruthy()
    const body = processMatch![1]
    const numbered = body.split('\n').filter(l => /^\d+\.\s/.test(l))
    expect(numbered).toHaveLength(8)
  })

  it('declares Agent tool as needed (documented in prose)', () => {
    // Reviewer spawns subagents via the Agent tool for review-architecture
    // and review-security; this isolates the skills' heavy context from
    // Agent B's window so the findings fence doesn't pull Agent B toward
    // early termination before emitting VERDICT.
    expect(prompt).toMatch(/via the `Agent`\s*\n?\s*tool/)
  })
})
