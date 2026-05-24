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

  it('no literal mutate path is a pure re-export barrel', () => {
    // A barrel file (every line is `export { X } from './foo.js'` or
    // `export type { Y } from './foo.js'`) has no behavioral surface
    // to mutate. Stryker mutates the `from` string literals, but no
    // behavior test could catch those — the public-surface contract
    // is "this name is re-exported," covered by typecheck + import,
    // not by runtime behavior. Mutants survive as NoCoverage noise
    // without finding real test gaps.
    const literals = config.mutate.filter(entry => !entry.includes('*'))
    const barrels = literals.filter(entry => {
      const url = new URL(`../${entry}`, import.meta.url)
      if (!existsSync(url)) return false
      const source = readFileSync(url, 'utf-8')
      // Strip comments + blank lines, then check every remaining line
      // is a re-export of the form `export ... from '...'`.
      const codeLines = source
        .split('\n')
        .map(l => l.replace(/\/\/.*$/, '').trim())
        .filter(l => l.length > 0 && !l.startsWith('/*') && !l.startsWith('*') && !l.startsWith('//'))
      if (codeLines.length === 0) return false
      // Allow multi-line re-exports: join by semicolons-or-braces, then check.
      // Heuristic: a barrel has ZERO `export const`, `export function`,
      // `export class`, `export async function`, `export default`.
      const hasDirectExport = /^export\s+(const|function|class|async\s+function|default)\s/m.test(source)
      if (hasDirectExport) return false
      // And every export must be a re-export (has `from '...'`).
      const exportLines = source.match(/^\s*export\s+/gm) ?? []
      const reExportLines = source.match(/^\s*export\s+(\*|type\s+\{|\{)[^]*?from\s+['"]/gm) ?? []
      // If every export statement has a `from` clause, it's a barrel.
      return exportLines.length > 0 && exportLines.length === reExportLines.length
    })
    expect(barrels).toEqual([])
  })
})
