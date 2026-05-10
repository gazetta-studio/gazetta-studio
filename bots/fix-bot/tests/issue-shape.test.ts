import { describe, expect, it } from 'vitest'
import { detectIssueSource, extractMutationSourcePath } from '../issue-shape.js'

describe('detectIssueSource', () => {
  it('detects mutation-watcher via outcome tag', () => {
    const body = 'Some body text\n<!-- mutation-watcher: source-run=12345 watcher-run=67890 -->'
    expect(detectIssueSource(body)).toBe('mutation-watcher')
  })

  it('detects flake-watcher via outcome tag', () => {
    const body = 'Some body text\n<!-- flake-watcher: run=12345 -->'
    expect(detectIssueSource(body)).toBe('flake-watcher')
  })

  it('returns null when no recognized outcome tag present', () => {
    expect(detectIssueSource('Just a regular issue body, no tags')).toBeNull()
    expect(detectIssueSource('')).toBeNull()
  })

  it('tolerates whitespace variations in the outcome tag', () => {
    expect(detectIssueSource('<!--mutation-watcher: foo=bar -->')).toBe('mutation-watcher')
    expect(detectIssueSource('<!--   mutation-watcher: foo=bar -->')).toBe('mutation-watcher')
  })
})

describe('extractMutationSourcePath', () => {
  it('extracts the source path from the locked mutation-watcher body shape', () => {
    const body = `## Pattern

Stryker found 136 actionable mutant(s) in \`src/publish-rendered.ts\` on
Mutation run 25621614362.`
    expect(extractMutationSourcePath(body)).toBe('src/publish-rendered.ts')
  })

  it('handles paths with multiple directory levels', () => {
    const body = 'Stryker found 5 actionable mutant(s) in `src/admin-api/routes/publish.ts` on'
    expect(extractMutationSourcePath(body)).toBe('src/admin-api/routes/publish.ts')
  })

  it('returns null when the body does not match (e.g. flake-watcher issue)', () => {
    const body = `## Pattern

\`tests/admin-api-archive-review.test.ts:94\` intermittently fails.`
    expect(extractMutationSourcePath(body)).toBeNull()
  })

  it('returns null on empty body', () => {
    expect(extractMutationSourcePath('')).toBeNull()
  })
})
