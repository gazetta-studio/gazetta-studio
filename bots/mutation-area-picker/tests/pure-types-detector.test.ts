import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverCandidates } from '../discover.js'
import {
  isPureTypesFile,
  isSparseMutationSurface,
  meaningfulLineCount,
  mutableSurfaceLineCount,
} from '../pure-types-detector.js'
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

describe('mutableSurfaceLineCount', () => {
  it('is 0 for a pure-types file', () => {
    const src = ['export type X = string', 'export interface Y { a: X }'].join('\n')
    expect(mutableSurfaceLineCount(src)).toBe(0)
  })

  it('is 1 for a file with a single top-level function', () => {
    const src = 'export function work(): number { return 42 }\n'
    expect(mutableSurfaceLineCount(src)).toBe(1)
  })

  it('counts inner `const` declarations inside function bodies', () => {
    // The pattern matches leading-whitespace-then-const, so a const
    // inside a function body counts. That's a load-bearing property:
    // it lets audit/pseudonymize.ts-shaped files hit the threshold of
    // 3 with 2 top-level functions + 1 inner const.
    const src = ['export function outer(): number {', '  const inner = 1', '  return inner', '}'].join('\n')
    expect(mutableSurfaceLineCount(src)).toBe(2)
  })

  it('counts three declarations in a genuinely-mixed file', () => {
    const src = [
      "import { createHash } from 'node:crypto'",
      'export function a(salt: string) {',
      "  const hash = createHash('sha256').update(salt).digest('hex')",
      '  return hash',
      '}',
      'export function b(x: string): string { return x }',
    ].join('\n')
    // export function a + inner const + export function b = 3
    expect(mutableSurfaceLineCount(src)).toBe(3)
  })

  it('ignores runtime-shaped substrings inside JSDoc prose', () => {
    // Comments are stripped before counting — narrative uses of "const"
    // in prose must not inflate the count.
    const src = [
      '/**',
      ' * Example: const foo = bar as const satisfies X',
      ' * This is prose about function declarations.',
      ' */',
      'export type X = string',
    ].join('\n')
    expect(mutableSurfaceLineCount(src)).toBe(0)
  })

  it('counts side-effect imports (matches isPureTypesFile behavior)', () => {
    // Side-effect imports are treated as runtime per rule 706 — they
    // could mutate global state and can't be reliably distinguished
    // from benign no-ops. Same rule applies here.
    const src = ["import './polyfill.js'", 'export type X = number'].join('\n')
    expect(mutableSurfaceLineCount(src)).toBe(1)
  })
})

describe('meaningfulLineCount', () => {
  it('excludes blank lines', () => {
    const src = ['export function a() {}', '', '', 'export function b() {}'].join('\n')
    expect(meaningfulLineCount(src)).toBe(2)
  })

  it('excludes JSDoc and line comments', () => {
    const src = [
      '/**',
      ' * Doc comment prose',
      ' */',
      'export type X = string',
      '// trailing note',
      'export interface Y { a: X }',
    ].join('\n')
    // The block-comment stripper collapses /** ... */ to '' and drops
    // // comments; only the two `export` lines remain non-blank.
    expect(meaningfulLineCount(src)).toBe(2)
  })

  it('counts type / interface declaration lines (they are file SIZE, not mutation surface)', () => {
    // Meaningful-line count is a SIZE proxy — types count too, because
    // "large file with 1 function" is exactly the shape we detect.
    const src = ['export interface A { x: number }', 'export interface B { y: number }', 'export type C = A | B'].join(
      '\n',
    )
    expect(meaningfulLineCount(src)).toBe(3)
  })
})

describe('isSparseMutationSurface', () => {
  it('is false for small utility files even with 1 declaration', () => {
    // A single-function file with 1-5 meaningful lines is a normal
    // small utility, not a near-pure-types file. Keeping it as a
    // candidate preserves the pre-#723 behavior for such files.
    const src = 'export function work(): number { return 42 }\n'
    expect(isSparseMutationSurface(src)).toBe(false)
  })

  it('is true for a large file with 1 declaration (the #723 shape)', () => {
    const src = [
      "import type { ComponentEntry } from './types.js'",
      "export type ValidationStage = 'save-delta' | 'background'",
      "type Severity = 'error' | 'warn' | 'info'",
      'export interface Issue {',
      '  validator: string',
      '  severity: Severity',
      '  message: string',
      '  itemPath: string',
      '  contentPath?: string',
      '  suppressible?: boolean',
      '}',
      'export interface SavedItem {',
      "  kind: 'page' | 'fragment'",
      '  name: string',
      '  itemPath: string',
      '}',
      'export interface ValidatorInput {',
      '  stage: ValidationStage',
      '  site: unknown',
      '  contentRoot: unknown',
      '  storage: unknown',
      '  scope: unknown',
      '}',
      'export function manifestComponents(m: { components?: readonly ComponentEntry[] } | null) {',
      '  return m?.components ?? []',
      '}',
    ].join('\n')
    // 1 mutable declaration, well over 20 meaningful lines → sparse.
    expect(isSparseMutationSurface(src)).toBe(true)
  })

  it('is false for a file with ≥3 declarations regardless of size', () => {
    // Once a file crosses the declaration floor, size doesn't matter —
    // "many declarations in a small file" is a normal small module.
    const src = [
      'export function a() { return 1 }',
      'export function b() { return 2 }',
      'export function c() { return 3 }',
    ].join('\n')
    expect(isSparseMutationSurface(src)).toBe(false)
  })

  it('accepts overridden thresholds for tuning', () => {
    const src = ['export function a() {}', 'export interface B {}', 'export type C = B'].join('\n')
    // Default thresholds: 1 decl + 3 lines → not sparse (small file).
    expect(isSparseMutationSurface(src)).toBe(false)
    // Bumping minDeclarations to 5 + lowering size floor to 1 forces
    // sparse for this file — the thresholds are the policy knob.
    expect(isSparseMutationSurface(src, { minDeclarations: 5, maxLinesWithoutMinDeclarations: 1 })).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration: discoverCandidates excludes near-pure-type files (#723)
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverCandidates — near-pure-types filter (issue #723)', () => {
  it('excludes a near-pure-types file (1 trivial function in a large types file — validation/types.ts shape)', () => {
    // Real fixture from #722: mutation-area-picker nominated
    // `packages/gazetta/src/validation/types.ts` (~150 lines of
    // `export type` / `export interface` PLUS one function returning
    // `manifest?.components ?? []`). `isPureTypesFile` correctly returns
    // false (there IS a runtime value), so the #708 filter lets it
    // through. But the only mutable surface is that one line — Stryker
    // yields ~2-3 mutants for a 150-line file. Low-yield: burns a glob
    // slot for negligible coverage signal.
    writeSrc(
      'packages/gazetta/src/validation/types.ts',
      [
        "export type ValidationStage = 'save-delta' | 'background' | 'pre-publish' | 'cli'",
        "type Severity = 'error' | 'warn' | 'info'",
        'export interface Issue {',
        '  validator: string',
        '  severity: Severity',
        '  message: string',
        '  itemPath: string',
        '  contentPath?: string',
        '  suppressible?: boolean',
        '}',
        'export interface SavedItem {',
        "  kind: 'page' | 'fragment'",
        '  name: string',
        '  itemPath: string',
        '}',
        'export interface RenderedOutputAccess {',
        '  htmlFor(item: SavedItem): Promise<string | null>',
        '}',
        'export interface ValidatorInput {',
        '  stage: ValidationStage',
        '  site: unknown',
        '  contentRoot: unknown',
        '  storage: unknown',
        '  scope: unknown',
        '  renderedOutput?: RenderedOutputAccess',
        '}',
        'export interface Validator {',
        '  readonly source: string',
        '  readonly name: string',
        '  readonly stages: readonly ValidationStage[]',
        '  defaultSeverity(stage: ValidationStage): Severity',
        '  validate(input: ValidatorInput): Promise<Issue[]>',
        '}',
        'export function manifestComponents(manifest: unknown): readonly unknown[] {',
        '  return (manifest as { components?: readonly unknown[] } | null)?.components ?? []',
        '}',
      ].join('\n'),
    )

    const result = discoverCandidates({
      repoRoot,
      currentMutateGlob: [],
      skipList: emptySkipList(),
    })

    expect(result).not.toContain('packages/gazetta/src/validation/types.ts')
  })

  it('includes a genuinely-mixed file with 3+ runtime declarations (audit/pseudonymize.ts shape)', () => {
    // Contrast fixture: multiple functions with real logic. The pattern
    // counts `export function pseudonymizeActor` + inner `const hash` +
    // `export function computePseudonymizedId` = 3 matches. At the
    // threshold, this file remains a normal candidate.
    writeSrc(
      'packages/gazetta/src/audit/pseudonymize.ts',
      [
        "import { createHash } from 'node:crypto'",
        "export type ActorPseudonymMode = 'none' | 'sha256'",
        'export function pseudonymizeActor(actor: { id: string }, mode: ActorPseudonymMode, salt?: string) {',
        "  if (mode === 'none') return actor",
        '  if (!salt || salt.length === 0) throw new Error("salt required")',
        "  const hash = createHash('sha256').update(actor.id + salt).digest('hex').slice(0, 16)",
        '  return { id: hash }',
        '}',
        'export function computePseudonymizedId(rawSub: string, salt: string): string {',
        "  return createHash('sha256').update(rawSub + salt).digest('hex').slice(0, 16)",
        '}',
      ].join('\n'),
    )

    const result = discoverCandidates({
      repoRoot,
      currentMutateGlob: [],
      skipList: emptySkipList(),
    })

    expect(result).toContain('packages/gazetta/src/audit/pseudonymize.ts')
  })

  it('layered filters: pure-types excluded by #708 gate, near-pure excluded by #723 gate, mixed included', () => {
    writeSrc('packages/gazetta/src/pure.ts', 'export type X = string\nexport interface Y { a: X }\n')
    // near-pure.ts: 1 function surrounded by enough types/interfaces
    // to cross the 20-meaningful-line size threshold. Small files with
    // 1 declaration would legitimately pass the size gate — this
    // fixture exercises the compounding "large + sparse" case #723
    // targets.
    writeSrc(
      'packages/gazetta/src/near-pure.ts',
      [
        'export interface Config {',
        '  level: number',
        '  name: string',
        '  enabled: boolean',
        '}',
        'export interface Options {',
        '  mode: string',
        '  verbose: boolean',
        '  timeout: number',
        '  retries: number',
        '}',
        'export interface Result {',
        '  ok: boolean',
        '  message: string',
        '  data: unknown',
        '  errors: readonly string[]',
        '}',
        'export type Handler = (c: Config) => Result',
        'export type AsyncHandler = (c: Config) => Promise<Result>',
        'export type Level = "trace" | "debug" | "info" | "warn" | "error"',
        'export function apply(c: Config): number {',
        '  return c.level + 1',
        '}',
      ].join('\n'),
    )
    writeSrc(
      'packages/gazetta/src/mixed.ts',
      ['export function a() { return 1 }', 'export function b() { return 2 }', 'export function c() { return 3 }'].join(
        '\n',
      ),
    )

    const result = discoverCandidates({
      repoRoot,
      currentMutateGlob: [],
      skipList: emptySkipList(),
    })

    expect(result).not.toContain('packages/gazetta/src/pure.ts')
    expect(result).not.toContain('packages/gazetta/src/near-pure.ts')
    expect(result).toContain('packages/gazetta/src/mixed.ts')
  })
})
