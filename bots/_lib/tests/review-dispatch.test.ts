import { describe, expect, it } from 'vitest'
import {
  ALL_ANGLES,
  type Angle,
  dispatch,
  matchesArchitecture,
  matchesComments,
  matchesSecurity,
  matchesTests,
  matchesTypes,
  parseNameStatus,
} from '../review-dispatch.js'

// Tests are derived from the dispatch table in design-code-review.md
// "Dispatch table" section + implementation doc Cut 2's table. NOT
// derived from observing the impl output (per team-preferences rule 31).

describe('dispatch — locked behavior from design-code-review.md', () => {
  it('always fires review-diff on any non-empty diff', () => {
    const result = dispatch({ files: [{ path: 'README.md' }] })
    expect(result).toContain('review-diff')
  })

  it('fires only review-diff on a non-special file with no other matches', () => {
    const result = dispatch({ files: [{ path: 'README.md' }] })
    expect(result).toEqual(['review-diff'])
  })

  it('fires review-tests when a test file is changed', () => {
    expect(dispatch({ files: [{ path: 'packages/gazetta/tests/auth.test.ts' }] })).toContain('review-tests')
  })

  it('fires review-tests for *.spec.ts in any directory', () => {
    expect(dispatch({ files: [{ path: 'apps/admin/src/foo.spec.ts' }] })).toContain('review-tests')
  })

  it('fires review-architecture when packages/gazetta/src/audit/ is touched', () => {
    expect(dispatch({ files: [{ path: 'packages/gazetta/src/audit/recorder.ts' }] })).toContain('review-architecture')
  })

  it('fires review-architecture when packages/gazetta/src/validation/ is touched', () => {
    expect(dispatch({ files: [{ path: 'packages/gazetta/src/validation/scanner.ts' }] })).toContain(
      'review-architecture',
    )
  })

  it('fires review-architecture when a design-*.md is modified', () => {
    expect(dispatch({ files: [{ path: '.claude/rules/design-audit.md' }] })).toContain('review-architecture')
  })

  it('fires review-architecture when an ADR is modified', () => {
    expect(dispatch({ files: [{ path: 'docs/adr/0011-bot-memory-cache-persistence.md' }] })).toContain(
      'review-architecture',
    )
  })

  it('fires review-security when admin-api/ is touched', () => {
    expect(dispatch({ files: [{ path: 'packages/gazetta/src/admin-api/routes/pages.ts' }] })).toContain(
      'review-security',
    )
  })

  it('fires review-security when providers/ is touched', () => {
    expect(dispatch({ files: [{ path: 'packages/gazetta/src/providers/r2.ts' }] })).toContain('review-security')
  })

  it('fires review-security when package.json is touched (dependency bump risk)', () => {
    expect(dispatch({ files: [{ path: 'package.json' }] })).toContain('review-security')
  })

  it('fires review-security when content includes fetch() call', () => {
    expect(
      dispatch({
        files: [
          { path: 'packages/gazetta/src/foo.ts', content: 'export async function f() {\n  return fetch(url);\n}' },
        ],
      }),
    ).toContain('review-security')
  })

  it('fires review-types when content includes a z.object call', () => {
    expect(
      dispatch({
        files: [
          { path: 'packages/gazetta/src/foo.ts', content: 'export const schema = z.object({ name: z.string() })' },
        ],
      }),
    ).toContain('review-types')
  })

  it('fires review-types when content includes a TypeScript interface declaration', () => {
    expect(
      dispatch({
        files: [{ path: 'packages/gazetta/src/foo.ts', content: 'interface User {\n  id: string;\n}' }],
      }),
    ).toContain('review-types')
  })

  it('fires review-types when content includes a TS type alias', () => {
    expect(
      dispatch({ files: [{ path: 'packages/gazetta/src/foo.ts', content: 'type ItemKind = "page" | "fragment"' }] }),
    ).toContain('review-types')
  })

  it('fires review-types on types.ts file regardless of content availability', () => {
    expect(dispatch({ files: [{ path: 'packages/gazetta/src/types.ts' }] })).toContain('review-types')
  })

  it('fires multiple angles when multiple file patterns hit', () => {
    const result = dispatch({
      files: [{ path: 'packages/gazetta/src/audit/recorder.ts' }, { path: 'packages/gazetta/tests/audit.test.ts' }],
    })
    expect(result).toContain('review-diff')
    expect(result).toContain('review-architecture')
    expect(result).toContain('review-tests')
  })

  it('returns angles in stable ALL_ANGLES order', () => {
    const result = dispatch({
      files: [
        { path: 'packages/gazetta/tests/audit.test.ts' }, // tests
        { path: 'packages/gazetta/src/audit/recorder.ts' }, // architecture
        { path: 'packages/gazetta/src/admin-api/routes/x.ts' }, // security
      ],
    })
    // Verify stable order matches the canonical ALL_ANGLES sequence.
    const indices = result.map(a => ALL_ANGLES.indexOf(a))
    const sorted = [...indices].sort((a, b) => a - b)
    expect(indices).toEqual(sorted)
  })

  it('dedupes when multiple files trigger the same angle', () => {
    const result = dispatch({
      files: [{ path: 'packages/gazetta/tests/a.test.ts' }, { path: 'packages/gazetta/tests/b.test.ts' }],
    })
    const testsCount = result.filter(a => a === ('review-tests' as Angle)).length
    expect(testsCount).toBe(1)
  })
})

describe('matchesTests — boundary cases', () => {
  it('matches a file inside tests/ directory', () => {
    expect(matchesTests({ path: 'tests/foo.ts' })).toBe(true)
  })

  it('matches *.test.ts pattern', () => {
    expect(matchesTests({ path: 'packages/foo/bar.test.ts' })).toBe(true)
  })

  it('matches *.spec.tsx pattern', () => {
    expect(matchesTests({ path: 'apps/admin/src/Foo.spec.tsx' })).toBe(true)
  })

  it('does not match plain source file', () => {
    expect(matchesTests({ path: 'packages/foo/bar.ts' })).toBe(false)
  })

  it('does not match docs', () => {
    expect(matchesTests({ path: 'docs/something.md' })).toBe(false)
  })
})

describe('matchesArchitecture — boundary cases', () => {
  it('matches each foundational src directory', () => {
    for (const dir of ['audit', 'validation', 'hooks', 'auth', 'review', 'scheduling', 'soft-delete']) {
      expect(matchesArchitecture({ path: `packages/gazetta/src/${dir}/file.ts` })).toBe(true)
    }
  })

  it('matches design-*.md but not other .md files', () => {
    expect(matchesArchitecture({ path: '.claude/rules/design-audit.md' })).toBe(true)
    expect(matchesArchitecture({ path: '.claude/rules/team-preferences.md' })).toBe(false)
    expect(matchesArchitecture({ path: 'README.md' })).toBe(false)
  })

  it('matches ADRs', () => {
    expect(matchesArchitecture({ path: 'docs/adr/0001-foo.md' })).toBe(true)
  })

  it('does not match plain src files outside foundational dirs', () => {
    expect(matchesArchitecture({ path: 'packages/gazetta/src/cli/index.ts' })).toBe(false)
  })
})

describe('matchesSecurity — boundary cases', () => {
  it('matches paths containing sanitize (case-insensitive)', () => {
    expect(matchesSecurity({ path: 'packages/gazetta/src/sanitize.ts' })).toBe(true)
    expect(matchesSecurity({ path: 'packages/gazetta/src/SanitizeHelper.ts' })).toBe(true)
  })

  it('matches paths containing capability', () => {
    expect(matchesSecurity({ path: 'packages/gazetta/src/auth/capabilities.ts' })).toBe(true)
  })

  it('does NOT fire on a plain README change', () => {
    expect(matchesSecurity({ path: 'README.md' })).toBe(false)
  })

  it('does NOT fire on a test file without other signals', () => {
    expect(matchesSecurity({ path: 'packages/gazetta/tests/foo.test.ts' })).toBe(false)
  })
})

describe('matchesComments — comment-only diff detection', () => {
  it('returns false without content', () => {
    expect(matchesComments({ path: 'foo.ts' })).toBe(false)
  })

  it('fires when all diff lines are comments', () => {
    const content = '+// Updated comment\n+// Another comment\n'
    expect(matchesComments({ path: 'foo.ts', content })).toBe(true)
  })

  it('does not fire when diff includes code changes', () => {
    const content = '+// comment\n+const x = 1\n'
    expect(matchesComments({ path: 'foo.ts', content })).toBe(false)
  })

  it('handles JSDoc-style continuation lines', () => {
    const content = '+/**\n+ * docstring\n+ */\n'
    expect(matchesComments({ path: 'foo.ts', content })).toBe(true)
  })
})

describe('matchesTypes — type-introduction detection', () => {
  it('detects z.object call', () => {
    expect(matchesTypes({ path: 'foo.ts', content: 'export const s = z.object({})' })).toBe(true)
  })

  it('detects z.discriminatedUnion', () => {
    expect(matchesTypes({ path: 'foo.ts', content: 'z.discriminatedUnion("kind", [])' })).toBe(true)
  })

  it('detects interface declaration with brace', () => {
    expect(matchesTypes({ path: 'foo.ts', content: 'interface User { id: string }' })).toBe(true)
  })

  it('detects interface with generic parameter', () => {
    expect(matchesTypes({ path: 'foo.ts', content: 'interface Box<T> { value: T }' })).toBe(true)
  })

  it('detects type alias', () => {
    expect(matchesTypes({ path: 'foo.ts', content: 'type Kind = "a" | "b"' })).toBe(true)
  })

  it('matches /types.ts files even without content', () => {
    expect(matchesTypes({ path: 'packages/gazetta/src/types.ts' })).toBe(true)
  })

  it('does not match plain const declaration', () => {
    expect(matchesTypes({ path: 'foo.ts', content: 'const x = 1' })).toBe(false)
  })
})

describe('parseNameStatus', () => {
  it('parses A/M/D lines', () => {
    const out = 'A\tnew-file.ts\nM\tchanged.ts\nD\tremoved.ts'
    const files = parseNameStatus(out)
    expect(files).toEqual([
      { path: 'new-file.ts', status: 'added' },
      { path: 'changed.ts', status: 'modified' },
      { path: 'removed.ts', status: 'deleted' },
    ])
  })

  it('parses a rename line picking the new path', () => {
    const out = 'R100\told/path.ts\tnew/path.ts'
    const files = parseNameStatus(out)
    expect(files).toEqual([{ path: 'new/path.ts', status: 'renamed' }])
  })

  it('skips blank lines', () => {
    expect(parseNameStatus('')).toEqual([])
    expect(parseNameStatus('\n\n')).toEqual([])
  })
})
