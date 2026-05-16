/**
 * Pins the StrykerJS mutation-testing scope.
 *
 * `mutate` is expanded smallest-first per testing-plan.md's "Mutation
 * scope expansion" sequence. A unit test guards the scope so it can't
 * silently regress when stryker.config.json is reformatted or rewritten,
 * and confirms every literal scope entry points at a real source file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const config = JSON.parse(
  readFileSync(new URL('../stryker.config.json', import.meta.url), 'utf-8'),
) as { mutate: string[] }

describe('stryker mutation scope', () => {
  it('includes hooks/registry.ts (testing-plan.md scope-expansion item 1)', () => {
    expect(config.mutate).toContain('src/hooks/registry.ts')
  })

  it('every literal mutate path resolves to an existing source file', () => {
    const literals = config.mutate.filter(entry => !entry.includes('*'))
    const missing = literals.filter(
      entry => !existsSync(new URL(`../${entry}`, import.meta.url)),
    )
    expect(missing).toEqual([])
  })
})
