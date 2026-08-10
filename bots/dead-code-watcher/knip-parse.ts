/**
 * Knip output parser + filter.
 *
 * Converts knip's `--reporter json` output into our internal
 * `Finding` shape — typed records the orchestrator can rank, dedup,
 * and serialize.
 *
 * Knip's JSON shape (knip 6.x, may shift across majors — we tolerate
 * unknown extra keys but require the documented core keys):
 *
 *   {
 *     "issues": [
 *       {
 *         "file": "<path>",
 *         "files": [{"name": "<path>"}],         // populated when file itself is unused
 *         "exports": [{"name": "<symbol>"}],     // unused exports in this file
 *         "types": [{"name": "<symbol>"}],
 *         "enumMembers": [{"name": "<symbol>"}],
 *         "dependencies": [{"name": "<pkg>"}],   // unused deps when file=package.json
 *         "devDependencies": [{"name": "<pkg>"}],
 *         // ... other shapes we don't currently consume
 *       }
 *     ]
 *   }
 */
import { execFileSync } from 'node:child_process'
import type { Fingerprint } from './skip-list.js'

/**
 * One actionable knip finding, projected into the shape the
 * orchestrator hands to Claude.
 *
 *   - fingerprint: stable identity for dedup + skip-list matching
 *   - file: path relative to repo root (always set)
 *   - symbol: export/type/dep name (set when kind != 'file')
 *   - lastModifiedDays: age in days since the file was last modified
 *     in git history. NaN when git log returns no commits (file
 *     untracked or just-added).
 */
export interface Finding {
  fingerprint: Fingerprint
  file: string
  symbol?: string
  lastModifiedDays: number
}

/** Knip's raw JSON shape — only the keys we consume. */
export interface KnipReport {
  issues: KnipIssueRecord[]
}
export interface KnipNamed {
  name: string
}
export interface KnipIssueRecord {
  file: string
  files?: KnipNamed[]
  exports?: KnipNamed[]
  types?: KnipNamed[]
  enumMembers?: KnipNamed[]
  dependencies?: KnipNamed[]
  devDependencies?: KnipNamed[]
}

/**
 * Project the knip JSON into a flat list of Findings.
 *
 * Each unique (kind, path, symbol?) becomes one Finding. A single
 * knip issue record can yield multiple findings — e.g., one file with
 * 5 unused exports yields 5 findings, each with kind='export' and a
 * different symbol.
 *
 * Files with kind='file' (entire file unused) do NOT also produce
 * per-export findings even when knip lists exports in the same
 * record — the whole-file remediation supersedes per-export.
 */
export function parseKnipReport(report: KnipReport, opts: { repoRoot: string }): Finding[] {
  const findings: Finding[] = []

  for (const record of report.issues) {
    const fileFindings = record.files ?? []
    const fileFlagged = fileFindings.length > 0

    if (fileFlagged) {
      for (const f of fileFindings) {
        findings.push({
          fingerprint: { kind: 'file', path: f.name },
          file: f.name,
          lastModifiedDays: gitLastModifiedDays(opts.repoRoot, f.name),
        })
      }
      // When the whole file is unused, skip per-symbol entries on
      // the same record — the file-level finding covers them.
      continue
    }

    for (const e of record.exports ?? []) {
      findings.push({
        fingerprint: { kind: 'export', path: record.file, symbol: e.name },
        file: record.file,
        symbol: e.name,
        lastModifiedDays: gitLastModifiedDays(opts.repoRoot, record.file),
      })
    }
    for (const t of record.types ?? []) {
      findings.push({
        fingerprint: { kind: 'type', path: record.file, symbol: t.name },
        file: record.file,
        symbol: t.name,
        lastModifiedDays: gitLastModifiedDays(opts.repoRoot, record.file),
      })
    }
    for (const m of record.enumMembers ?? []) {
      findings.push({
        fingerprint: { kind: 'enumMember', path: record.file, symbol: m.name },
        file: record.file,
        symbol: m.name,
        lastModifiedDays: gitLastModifiedDays(opts.repoRoot, record.file),
      })
    }
    for (const d of record.dependencies ?? []) {
      findings.push({
        fingerprint: { kind: 'dependency', path: record.file, symbol: d.name },
        file: record.file,
        symbol: d.name,
        // Dependency findings use the package.json's last-modified date
        // as a stand-in. Adding a dep is a package.json edit; deps
        // older than 30 days are stable candidates.
        lastModifiedDays: gitLastModifiedDays(opts.repoRoot, record.file),
      })
    }
    for (const d of record.devDependencies ?? []) {
      findings.push({
        fingerprint: { kind: 'devDependency', path: record.file, symbol: d.name },
        file: record.file,
        symbol: d.name,
        lastModifiedDays: gitLastModifiedDays(opts.repoRoot, record.file),
      })
    }
  }

  return findings
}

/**
 * Git-log age in days for a file. Uses the latest commit that
 * touched the file. Returns NaN when git knows nothing about it
 * (uncommitted, or new file).
 *
 * Synchronous on purpose — keeps the parser pipeline a pure
 * read+transform without async surface. Cost is one execFileSync per
 * unique file; knip reports typically have <100 unique files.
 *
 * execFileSync (not execSync) so `path` reaches git as a literal argv
 * element — no shell in the middle rewriting `$var`, evaluating
 * backticks / `$()`, or splitting on unquoted spaces.
 */
export function gitLastModifiedDays(repoRoot: string, path: string): number {
  try {
    const isoTimestamp = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!isoTimestamp) return Number.NaN
    const lastCommit = new Date(isoTimestamp).getTime()
    const ageMs = Date.now() - lastCommit
    return Math.floor(ageMs / (24 * 60 * 60 * 1000))
  } catch {
    return Number.NaN
  }
}

/** Filter to findings older than the threshold (default 30 days). */
export function filterStableFindings(findings: Finding[], minDays = 30): Finding[] {
  return findings.filter(f => Number.isFinite(f.lastModifiedDays) && f.lastModifiedDays >= minDays)
}

/**
 * Sort findings by impact, oldest-first within each kind:
 *
 *   1. files (highest impact — whole-file delete)
 *   2. dependencies + devDependencies (supply-chain reduction)
 *   3. exports + types (export-surface cleanup)
 *   4. enumMembers (lowest — single-symbol change)
 *
 * Within each tier, oldest-modified first (longer-stale = safer
 * candidate, less likely to be mid-flight WIP).
 */
export function rankFindings(findings: Finding[]): Finding[] {
  const tier = (kind: Fingerprint['kind']): number => {
    if (kind === 'file') return 0
    if (kind === 'dependency' || kind === 'devDependency') return 1
    if (kind === 'export' || kind === 'type') return 2
    return 3 // enumMember
  }
  return [...findings].sort((a, b) => {
    const ta = tier(a.fingerprint.kind)
    const tb = tier(b.fingerprint.kind)
    if (ta !== tb) return ta - tb
    // Older = bigger lastModifiedDays = ranked higher
    return b.lastModifiedDays - a.lastModifiedDays
  })
}
