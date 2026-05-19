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

const config = JSON.parse(readFileSync(new URL('../stryker.config.json', import.meta.url), 'utf-8')) as {
  mutate: string[]
}

describe('stryker mutation scope', () => {
  it('includes hooks/registry.ts (testing-plan.md scope-expansion item 1)', () => {
    expect(config.mutate).toContain('src/hooks/registry.ts')
  })

  it('every literal mutate path resolves to an existing source file', () => {
    const literals = config.mutate.filter(entry => !entry.includes('*'))
    const missing = literals.filter(entry => !existsSync(new URL(`../${entry}`, import.meta.url)))
    expect(missing).toEqual([])
  })

  it('no literal mutate path is a shebang entrypoint', () => {
    // Stryker's vitest runner instruments modules in-process. A `#!`
    // entrypoint runs only as a spawned subprocess (e2e / CLI-smoke
    // tests), so the runner never observes its mutants — every one
    // survives as NoCoverage, producing pure noise rather than signal.
    const literals = config.mutate.filter(entry => !entry.includes('*'))
    const shebangEntrypoints = literals.filter(entry => {
      const url = new URL(`../${entry}`, import.meta.url)
      return existsSync(url) && readFileSync(url, 'utf-8').startsWith('#!')
    })
    expect(shebangEntrypoints).toEqual([])
  })
})
