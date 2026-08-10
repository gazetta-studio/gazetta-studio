import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { filterStableFindings, gitLastModifiedDays, parseKnipReport, rankFindings, type Finding } from '../knip-parse.js'

// Most parser tests stub `repoRoot` to a non-git directory → git log
// returns NaN → findings get filtered out. `gitLastModifiedDays` itself
// shells out to git; the dedicated tempdir-git test below covers its
// shell-argument-safety contract because that's the only way to prove
// filenames with shell metacharacters aren't reinterpreted by the shell.

describe('parseKnipReport — finding kinds', () => {
  it('emits one finding per file when kind=file', () => {
    const report = {
      issues: [
        {
          file: 'src/foo.ts',
          files: [{ name: 'src/foo.ts' }],
        },
      ],
    }
    const findings = parseKnipReport(report, { repoRoot: '/nonexistent' })
    expect(findings).toHaveLength(1)
    expect(findings[0].fingerprint).toEqual({ kind: 'file', path: 'src/foo.ts' })
    expect(findings[0].file).toBe('src/foo.ts')
  })

  it('emits one finding per export when kind=export', () => {
    const report = {
      issues: [
        {
          file: 'src/foo.ts',
          exports: [{ name: 'bar' }, { name: 'baz' }],
        },
      ],
    }
    const findings = parseKnipReport(report, { repoRoot: '/nonexistent' })
    expect(findings).toHaveLength(2)
    expect(findings[0].fingerprint).toEqual({ kind: 'export', path: 'src/foo.ts', symbol: 'bar' })
    expect(findings[1].fingerprint).toEqual({ kind: 'export', path: 'src/foo.ts', symbol: 'baz' })
  })

  it('emits findings for types separately from exports', () => {
    const report = {
      issues: [
        {
          file: 'src/foo.ts',
          exports: [{ name: 'bar' }],
          types: [{ name: 'MyType' }],
        },
      ],
    }
    const findings = parseKnipReport(report, { repoRoot: '/nonexistent' })
    expect(findings).toHaveLength(2)
    expect(findings.map(f => f.fingerprint.kind)).toEqual(['export', 'type'])
  })

  it('emits findings for dependencies on package.json records', () => {
    const report = {
      issues: [
        {
          file: 'apps/admin/package.json',
          dependencies: [{ name: 'primeicons' }, { name: 'zod' }],
          devDependencies: [{ name: 'vitest' }],
        },
      ],
    }
    const findings = parseKnipReport(report, { repoRoot: '/nonexistent' })
    expect(findings).toHaveLength(3)
    expect(findings.map(f => f.fingerprint.kind)).toEqual(['dependency', 'dependency', 'devDependency'])
    expect(findings.map(f => f.fingerprint.symbol)).toEqual(['primeicons', 'zod', 'vitest'])
  })

  it('skips per-export findings when the whole file is unused', () => {
    const report = {
      issues: [
        {
          file: 'src/foo.ts',
          files: [{ name: 'src/foo.ts' }],
          // Knip sometimes lists exports on whole-file-unused records;
          // the file-level finding supersedes — file deletion drops them all.
          exports: [{ name: 'bar' }],
        },
      ],
    }
    const findings = parseKnipReport(report, { repoRoot: '/nonexistent' })
    expect(findings).toHaveLength(1)
    expect(findings[0].fingerprint.kind).toBe('file')
  })

  it('handles missing optional fields gracefully', () => {
    const report = {
      issues: [
        {
          file: 'src/foo.ts',
          // No files / exports / types / deps — empty record
        },
      ],
    }
    const findings = parseKnipReport(report, { repoRoot: '/nonexistent' })
    expect(findings).toEqual([])
  })

  it('processes multiple issue records independently', () => {
    const report = {
      issues: [
        { file: 'src/a.ts', exports: [{ name: 'X' }] },
        { file: 'src/b.ts', files: [{ name: 'src/b.ts' }] },
      ],
    }
    const findings = parseKnipReport(report, { repoRoot: '/nonexistent' })
    expect(findings).toHaveLength(2)
    expect(findings.map(f => f.fingerprint.kind)).toEqual(['export', 'file'])
  })
})

describe('filterStableFindings', () => {
  function makeFinding(overrides: Partial<Finding>): Finding {
    return {
      fingerprint: { kind: 'file', path: 'src/foo.ts' },
      file: 'src/foo.ts',
      lastModifiedDays: 100,
      ...overrides,
    }
  }

  it('keeps findings older than threshold (default 30 days)', () => {
    const findings = [makeFinding({ lastModifiedDays: 45 }), makeFinding({ lastModifiedDays: 100 })]
    expect(filterStableFindings(findings)).toHaveLength(2)
  })

  it('drops findings younger than threshold', () => {
    const findings = [makeFinding({ lastModifiedDays: 5 }), makeFinding({ lastModifiedDays: 25 })]
    expect(filterStableFindings(findings)).toHaveLength(0)
  })

  it('drops findings with NaN age (file not in git)', () => {
    const findings = [makeFinding({ lastModifiedDays: Number.NaN })]
    expect(filterStableFindings(findings)).toHaveLength(0)
  })

  it('threshold boundary is inclusive — exactly minDays passes', () => {
    const findings = [makeFinding({ lastModifiedDays: 30 })]
    expect(filterStableFindings(findings, 30)).toHaveLength(1)
  })

  it('accepts custom minDays threshold', () => {
    const findings = [makeFinding({ lastModifiedDays: 10 }), makeFinding({ lastModifiedDays: 50 })]
    expect(filterStableFindings(findings, 5)).toHaveLength(2)
    expect(filterStableFindings(findings, 20)).toHaveLength(1)
  })
})

describe('rankFindings', () => {
  function f(kind: Finding['fingerprint']['kind'], path: string, ageDays: number, symbol?: string): Finding {
    return {
      fingerprint: { kind, path, symbol },
      file: path,
      symbol,
      lastModifiedDays: ageDays,
    }
  }

  it('ranks files above deps above exports above enumMembers', () => {
    const findings = [
      f('enumMember', 'src/d.ts', 100, 'X'),
      f('export', 'src/c.ts', 100, 'Y'),
      f('dependency', 'pkg/package.json', 100, 'lodash'),
      f('file', 'src/a.ts', 100),
    ]
    const ranked = rankFindings(findings)
    expect(ranked.map(r => r.fingerprint.kind)).toEqual(['file', 'dependency', 'export', 'enumMember'])
  })

  it('within same tier sorts oldest-first', () => {
    const findings = [f('file', 'src/recent.ts', 30), f('file', 'src/ancient.ts', 365), f('file', 'src/middle.ts', 90)]
    const ranked = rankFindings(findings)
    expect(ranked.map(r => r.file)).toEqual(['src/ancient.ts', 'src/middle.ts', 'src/recent.ts'])
  })

  it('does not mutate input array', () => {
    const findings = [f('file', 'src/a.ts', 100)]
    const ranked = rankFindings(findings)
    expect(ranked).not.toBe(findings)
  })

  it('groups types with exports in the same tier', () => {
    const findings = [f('type', 'src/types.ts', 50, 'T'), f('export', 'src/exports.ts', 100, 'E')]
    const ranked = rankFindings(findings)
    // Both kind 2; oldest-first → export (100) before type (50)
    expect(ranked.map(r => r.fingerprint.kind)).toEqual(['export', 'type'])
  })
})

describe('gitLastModifiedDays — shell-metacharacter safety', () => {
  // Regression guard for the execSync-with-string-interpolation defect.
  // When the path passed to `git log` is spliced into a shell string,
  // a `$` in the filename is expanded as a shell variable — an unset
  // one collapses to empty, so git looks up the wrong path and returns
  // no commits. The fix is `execFileSync(..., [path])`, which passes
  // the path as a literal argv element that the shell never sees.
  //
  // Beyond correctness, this closes a command-injection class: any
  // shell metacharacter in a knip-reported filename (backticks, `$()`,
  // `;`, etc.) would otherwise be evaluated by /bin/sh in the bot's
  // runner environment.
  it('resolves a tracked file whose name contains a shell metacharacter', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'git-metachar-'))
    try {
      const opts = { cwd: repoRoot, stdio: 'ignore' as const }
      execFileSync('git', ['init', '-q', '-b', 'main'], opts)
      execFileSync('git', ['config', 'user.email', 't@e.st'], opts)
      execFileSync('git', ['config', 'user.name', 't'], opts)
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts)
      // A bare `$` triggers shell variable expansion under the buggy
      // path — $UNSET reads as empty, so git receives "sub.ts" instead
      // of the actual filename and returns nothing → NaN.
      const path = 'sub$UNSET.ts'
      writeFileSync(join(repoRoot, path), 'x')
      execFileSync('git', ['add', '--', path], opts)
      execFileSync('git', ['commit', '-q', '-m', 'seed'], opts)

      const days = gitLastModifiedDays(repoRoot, path)
      // File was just committed. The load-bearing assertion is that
      // git found it at all — a finite (not NaN) result means the
      // shell didn't rewrite the path away.
      expect(Number.isFinite(days)).toBe(true)
      expect(days).toBeGreaterThanOrEqual(0)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
