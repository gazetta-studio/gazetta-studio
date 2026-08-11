import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverCandidates } from '../discover.js'
import { isPureTypesFile } from '../pure-types-detector.js'
import { emptySkipList } from '../skip-list.js'

/**
 * Regression test for issue #706: mutation-area-picker proposed adding
 * `packages/gazetta/src/audit/types.ts` (183 lines of pure `export type`
 * / `export interface` declarations) to the Stryker `mutate` glob.
 * TypeScript types are erased at compile time — Stryker generates 0
 * mutants for such files, so any glob budget spent on them yields no
 * signal AND registers as vacuously 100% killed (0/0), which the
 * eviction rule reads as "graduated well-covered module." The pre-
 * filter runs BEFORE the weighted inclusion score so a high churn /
 * AI-density signal on a pure-type file can't override it.
 */

describe('isPureTypesFile', () => {
  it('is true for a file with only `export type` and `export interface`', () => {
    const src = [
      "export type AuditAction = 'save' | 'publish'",
      'export interface AuditEvent {',
      '  timestamp: string',
      '  action: AuditAction',
      '}',
      "export type AuditOutcome = 'success' | 'failure'",
    ].join('\n')
    expect(isPureTypesFile(src)).toBe(true)
  })

  it('is true when JSDoc comments surround pure-type declarations', () => {
    const src = `
/**
 * Doc comments MUST NOT trigger runtime-value detection — prose
 * legitimately contains words like "const" or "as const" in narrative.
 *
 * Example: an interface satisfies a class of contracts (prose usage).
 */
export interface AuditActor {
  /** Stable subject identifier. */
  id: string
  /** Trust mode that produced this principal. */
  trustMode: string
}
`
    expect(isPureTypesFile(src)).toBe(true)
  })

  it('is false when the file exports a const', () => {
    const src = 'export const DEFAULT_MODEL = "claude-haiku-4-5"\nexport type X = number\n'
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false when the file exports a function', () => {
    const src = 'export function pseudonymize(sub: string): string { return sub }\nexport type X = number\n'
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false when the file exports a class', () => {
    const src = 'export class MyClass { greet() { return "hi" } }\n'
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false when the file exports an enum', () => {
    const src = 'export enum Level { Low, High }\n'
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false when the file uses `as const`', () => {
    const src = "export const ACTIONS = ['save', 'publish'] as const\n"
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false when the file uses `satisfies`', () => {
    const src = 'const config = { level: "info" } satisfies LoggerConfig\n'
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false when the file has an async function', () => {
    const src = 'export async function record(event: AuditEvent): Promise<void> { }\n'
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false when the file has export default', () => {
    const src = 'export default function main() { return 42 }\n'
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false when the file has a non-exported module-level const', () => {
    const src = 'const PRIVATE = 42\nexport type X = typeof PRIVATE\n'
    expect(isPureTypesFile(src)).toBe(false)
  })

  it('is false for a file with a let/var declaration', () => {
    expect(isPureTypesFile('let counter = 0\n')).toBe(false)
    expect(isPureTypesFile('var legacy = 1\n')).toBe(false)
  })

  it('is true for a file with only import statements and type re-exports', () => {
    const src = [
      "import type { Something } from './other.js'",
      "export type { Something } from './other.js'",
      'export type X = Something',
    ].join('\n')
    expect(isPureTypesFile(src)).toBe(true)
  })

  it('is false for a file with side-effect imports (has runtime behavior)', () => {
    // A pure side-effect import (`import './polyfill.js'`) is arguably
    // zero-mutant BUT can't be reliably distinguished from a module
    // that mutates global state. Err toward INCLUDING per the issue's
    // recommendation.
    const src = "import './polyfill.js'\nexport type X = number\n"
    expect(isPureTypesFile(src)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration: discoverCandidates excludes pure-type files
// ─────────────────────────────────────────────────────────────────────────────

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'map-pure-types-test-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function writeSrc(relPath: string, content: string): void {
  const abs = join(repoRoot, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

describe('discoverCandidates — pure-types filter', () => {
  it('excludes pure-type files (issue #706 fixture: audit/types.ts vs pseudonymize.ts)', () => {
    // Real fixture from #700: audit/types.ts is pure types (no runtime),
    // audit/pseudonymize.ts has functions (mutation-eligible).
    writeSrc(
      'packages/gazetta/src/audit/types.ts',
      [
        "export type AuditAction = 'save' | 'publish' | 'delete'",
        'export interface AuditActor {',
        '  id: string',
        '  role: string',
        '}',
        'export interface AuditEvent {',
        '  timestamp: string',
        '  actor: AuditActor',
        '  action: AuditAction',
        '}',
      ].join('\n'),
    )
    writeSrc(
      'packages/gazetta/src/audit/pseudonymize.ts',
      [
        "import { createHash } from 'node:crypto'",
        'export function pseudonymize(sub: string, salt: string): string {',
        "  return createHash('sha256').update(sub + salt).digest('hex').slice(0, 16)",
        '}',
      ].join('\n'),
    )

    const result = discoverCandidates({
      repoRoot,
      currentMutateGlob: [],
      skipList: emptySkipList(),
    })

    expect(result).toContain('packages/gazetta/src/audit/pseudonymize.ts')
    expect(result).not.toContain('packages/gazetta/src/audit/types.ts')
  })

  it('includes a file that mixes types with runtime declarations', () => {
    writeSrc(
      'packages/gazetta/src/foo/mixed.ts',
      [
        'export type Config = { level: number }',
        'export const DEFAULT: Config = { level: 0 }',
        'export function apply(c: Config): number { return c.level + 1 }',
      ].join('\n'),
    )

    const result = discoverCandidates({
      repoRoot,
      currentMutateGlob: [],
      skipList: emptySkipList(),
    })

    expect(result).toContain('packages/gazetta/src/foo/mixed.ts')
  })

  it('pre-filter runs before scoring: a pure-type file is never a candidate regardless of churn', () => {
    // Acceptance criterion: pre-filter runs BEFORE the weighted
    // inclusion score, so churn/AI-density signals on a pure-type
    // file can't override the exclusion. Since discoverCandidates
    // returns the pool that scoring runs against, absence from
    // that pool is what proves the pre-filter fires first.
    writeSrc('packages/gazetta/src/types-only.ts', 'export type X = string\nexport interface Y { a: X }\n')
    writeSrc('packages/gazetta/src/real-module.ts', 'export function work(): number { return 42 }\n')

    const result = discoverCandidates({
      repoRoot,
      currentMutateGlob: [],
      skipList: emptySkipList(),
    })

    expect(result).not.toContain('packages/gazetta/src/types-only.ts')
    expect(result).toContain('packages/gazetta/src/real-module.ts')
  })
})
