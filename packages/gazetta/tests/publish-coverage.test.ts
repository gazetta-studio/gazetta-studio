/**
 * Mutation-coverage backfill for src/publish.ts (issue #638).
 *
 * StrykerJS surfaced surviving + no-coverage mutants in three clusters:
 *   1. copyRecursive's nested-directory recursion (lines 70-72; conditional at 70)
 *   2. copyRecursive's file-branch success path (lines 50-55) + dirname helper
 *      (string literals at 82, 84)
 *   3. collectDependencies' visited-guard (line 110) + missing-manifest
 *      fallback (lines 121-123)
 *
 * Existing publish.test.ts covers flat page/fragment directories where the leaf
 * is a manifest one level deep. That shape never exercises the nested-directory
 * recursion at line 71, never calls copyRecursive on a file path (line 51's
 * readFile-success), and never presents collectDependencies with a fragment
 * cycle or a manifest-less item. These tests pin the behavior on those paths.
 *
 * Uses memoryStorage per team-preferences rule 26 (test-isolation paranoia):
 * fresh storage per test, no cross-test state, no filesystem tempdir races.
 */
import { describe, expect, it } from 'vitest'
import { publishItems, resolveDependencies } from '../src/publish.js'
import { createContentRoot } from '../src/content-root.js'
import { memoryStorage } from './_helpers/memory-storage.js'

describe('publishItems — nested directory recursion (issue #638 cluster 1)', () => {
  it('copies a directory tree with subdirectories, recursing through each level', async () => {
    // Two levels of nested subdirs beneath the item root; leaf files at
    // different depths. The mapLimit at line 67 sees a directory entry at
    // the top level → line 70's `entry.isDirectory` fires → line 71 recurses
    // into copyRecursive on the subdir. Force-false on the conditional or
    // block-replace on 70-72 makes the recursion skip the subdir, and the
    // subdir's readFile at line 51 throws (memory storage's readFile on a
    // directory-shaped key throws ENOENT), so publishItems rejects.
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/complex/page.json': JSON.stringify({ template: 'default' }),
      'pages/complex/nested/inner.json': JSON.stringify({ value: 'a' }),
      'pages/complex/nested/deep/leaf.json': JSON.stringify({ value: 'b' }),
    })

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), ['pages/complex'])

    expect(copiedFiles).toBe(3)
    expect(await target.exists('pages/complex/page.json')).toBe(true)
    expect(await target.exists('pages/complex/nested/inner.json')).toBe(true)
    expect(await target.exists('pages/complex/nested/deep/leaf.json')).toBe(true)
    // Preserve the leaf's exact bytes — proves the write, not just the mkdir.
    expect(await target.readFile('pages/complex/nested/deep/leaf.json')).toBe(JSON.stringify({ value: 'b' }))
  })

  it('copies mixed file + subdirectory children in one directory', async () => {
    // Sibling file (page.json) + sibling directory (assets/) at the same
    // level. Exercises both branches of the line-70 conditional in one
    // mapLimit call: the file goes through line 73's readFile+writeFile
    // path; the subdirectory goes through line 71's recursion.
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/mixed/page.json': JSON.stringify({ template: 'x' }),
      'pages/mixed/assets/one.txt': 'hello',
      'pages/mixed/assets/two.txt': 'world',
    })

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), ['pages/mixed'])

    expect(copiedFiles).toBe(3)
    expect(await target.readFile('pages/mixed/page.json')).toBe(JSON.stringify({ template: 'x' }))
    expect(await target.readFile('pages/mixed/assets/one.txt')).toBe('hello')
    expect(await target.readFile('pages/mixed/assets/two.txt')).toBe('world')
  })
})

describe('publishItems — file-path item (issue #638 cluster 2)', () => {
  it('copies a single file when the item path resolves to a file, not a directory', async () => {
    // publishItems' item list normally names directories (`pages/home`), but
    // the underlying copyRecursive handles file paths too via its file-branch
    // (lines 50-55). No existing test exercises the branch to SUCCESS: the
    // outer copyRecursive on a directory hits line 51's readFile, which
    // throws (it's a directory), so the try body never runs to completion.
    // When the item IS a file, readFile succeeds, dirname runs (lines 82+84
    // string literals), mkdir + writeFile land the copy. Block-replace on
    // 50-55 makes the whole try body a no-op; then exists() sees the file,
    // readDir on a file returns [] under memory storage, mkdir(targetPath)
    // creates the "directory" (memory: no-op), and mapLimit([]) returns 0
    // — 0 !== 1, mutation dies.
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/single/page.json': JSON.stringify({ template: 'default', content: { title: 'S' } }),
    })

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), [
      'pages/single/page.json',
    ])

    expect(copiedFiles).toBe(1)
    expect(await target.readFile('pages/single/page.json')).toBe(
      JSON.stringify({ template: 'default', content: { title: 'S' } }),
    )
  })
})

describe('resolveDependencies — visited-guard against fragment cycles (issue #638 cluster 3)', () => {
  it('terminates when fragments reference each other cyclically', async () => {
    // fragments/a includes @b; fragments/b includes @a. resolveDependencies
    // starts from pages/home which includes @a. Original code's `visited`
    // set (line 110) short-circuits the second visit to fragments/a and the
    // recursion terminates. Force-false on line 110's guard removes
    // memoization → collectDependencies recurses a→b→a→b→... until the call
    // stack overflows and the promise rejects. Test asserts the call
    // returns (i.e. doesn't hang or throw), proving the guard is
    // load-bearing.
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'default', components: ['@a'] }),
      'fragments/a/fragment.json': JSON.stringify({ template: 'ta', components: ['@b'] }),
      'fragments/b/fragment.json': JSON.stringify({ template: 'tb', components: ['@a'] }),
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])

    expect(deps).toContain('pages/home')
    expect(deps).toContain('fragments/a')
    expect(deps).toContain('fragments/b')
    expect(deps).toContain('templates/default')
    expect(deps).toContain('templates/ta')
    expect(deps).toContain('templates/tb')
    // Each item resolved exactly once (dedup via allItems Set + visited guard).
    expect(deps.filter(d => d === 'fragments/a')).toHaveLength(1)
    expect(deps.filter(d => d === 'fragments/b')).toHaveLength(1)
  })

  it('terminates on a self-referencing fragment', async () => {
    // Tightest cycle: fragments/self → @self. Same guard, minimal setup.
    const storage = memoryStorage()
    storage.seed({
      'fragments/self/fragment.json': JSON.stringify({ template: 't', components: ['@self'] }),
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['fragments/self'])

    expect(deps).toContain('fragments/self')
    expect(deps).toContain('templates/t')
    expect(deps.filter(d => d === 'fragments/self')).toHaveLength(1)
  })
})

describe('resolveDependencies — item without a manifest (issue #638 cluster 3)', () => {
  it('returns the item unchanged when neither page.json nor fragment.json exists', async () => {
    // collectDependencies tries page.json then fragment.json; both readFile
    // calls throw ENOENT; the try/catch at 118-123 lets each iteration
    // continue; after the loop, manifest is still null → line 126 returns.
    // The item stays in allItems (added at the top of resolveDependencies)
    // but no template/component deps are collected. Regression pin for the
    // "no manifest → don't throw, don't collect" contract.
    const storage = memoryStorage()
    // No manifest at pages/orphan/ — but an unrelated file exists so
    // readDir wouldn't be empty if we were listing. We're not; the code
    // walks manifestNames one by one.
    storage.seed({
      'pages/orphan/notes.txt': 'no manifest here',
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['pages/orphan'])

    expect(deps).toContain('pages/orphan')
    expect(deps).toHaveLength(1)
  })

  it('reads fragment.json when page.json is missing (loop advances past first failure)', async () => {
    // The catch/continue at lines 121-123 is what lets the loop try the
    // NEXT manifest name after the first read throws. Without it (or with a
    // mutation that breaks the iteration), fragments would never resolve
    // when only fragment.json exists. Assert the fragment's template
    // dependency is picked up — that only happens if collectDependencies
    // successfully reads fragment.json after page.json's readFile threw.
    const storage = memoryStorage()
    storage.seed({
      'fragments/only/fragment.json': JSON.stringify({ template: 'frag-only' }),
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['fragments/only'])

    expect(deps).toContain('fragments/only')
    expect(deps).toContain('templates/frag-only')
  })
})

describe('resolveDependencies — manifest and component guards (issue #712)', () => {
  it('does not fabricate templates/undefined when manifest omits the template field', async () => {
    // Line 122 guards `typeof manifest.template === 'string'`. A manifest
    // with `components: []` but NO `template` field satisfies neither
    // arm's precondition; correct code skips the templates-set add and
    // never coins `templates/undefined`. Force-true on the conditional
    // enters the add branch with `manifest.template === undefined`,
    // producing the literal string `templates/undefined` in deps.
    const storage = memoryStorage()
    storage.seed({
      'pages/no-template/page.json': JSON.stringify({ components: [] }),
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['pages/no-template'])

    expect(deps).toContain('pages/no-template')
    expect(deps).not.toContain('templates/undefined')
    expect(deps.filter(d => d.startsWith('templates/'))).toEqual([])
  })

  it('ignores string components that do not start with @', async () => {
    // Line 139 uses `entry.startsWith('@')` to gate the fragment-ref
    // branch. Mutating the literal `'@'` to `''` makes every string
    // component match (any string starts with the empty string); the
    // code then slices off the first char and adds a spurious
    // `fragments/<mutilated-name>` entry. Correct code leaves the
    // non-@ string untouched.
    const storage = memoryStorage()
    storage.seed({
      'pages/mixed-strings/page.json': JSON.stringify({
        template: 'default',
        components: ['@header', 'inline-note'],
      }),
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['pages/mixed-strings'])

    // Only `fragments/header` should be present; the plain string
    // `'inline-note'` must not become a fragment reference. Asserting
    // the exact fragments set catches both `fragments/inline-note` and
    // `fragments/nline-note` (mutated slice(1) form) — kills the '@'→''
    // literal mutation regardless of how the mutant reshapes the name.
    expect(deps.filter(d => d.startsWith('fragments/')).sort()).toEqual(['fragments/header'])
  })

  it('skips null entries in component arrays without throwing', async () => {
    // Line 143 guards `typeof entry === 'object' && entry !== null`.
    // Both mutations (force-true on the conditional; `&&` → `||`) let
    // `null` fall into the object branch, which then reads
    // `null.template` and throws TypeError. Correct code short-circuits
    // via `entry !== null` and moves on to the next entry, so the
    // sibling object component's `templates/hero` still lands in deps.
    const storage = memoryStorage()
    storage.seed({
      'pages/null-entry/page.json': JSON.stringify({
        template: 'default',
        components: [null, { template: 'hero' }],
      }),
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['pages/null-entry'])

    expect(deps).toContain('templates/default')
    expect(deps).toContain('templates/hero')
  })
})
