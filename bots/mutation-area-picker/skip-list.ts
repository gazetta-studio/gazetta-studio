/**
 * Mutation-area-picker skip-list — durable memory of modules the bot
 * should NEVER propose for the mutate glob.
 *
 * Same architectural shape as dead-code-watcher's and fix-bot's
 * skip-lists, with a different fingerprint type: identity is a source
 * module path, not a knip finding or GitHub issue number.
 *
 * Two entry kinds:
 *
 *   - **never-mutate**: generated code, third-party shims, files where
 *     mutation testing is meaningless (e.g., type-only modules with no
 *     runtime behaviour to mutate). Permanent — never expires.
 *
 *   - **maintainer-rejected**: bot proposed adding this module via PR;
 *     maintainer closed the PR. The reason is mined from the close
 *     comment and stored as `reasonNote`. The skip is durable but the
 *     monthly compactor can promote recurring rejection patterns into
 *     lessons-learned.md.
 *
 * Lessons-learned (the cross-run pattern memory) lives in
 * `bots/mutation-area-picker/lessons-learned.md` and is loaded by the
 * bot's prompt directly. Skip-list is the per-module gate;
 * lessons-learned is the cross-module heuristic-calibration wisdom.
 * Different files, different update cadences.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Fingerprint — uniquely identifies a source module the bot might
 * propose. Always a relative path from the repo root (e.g.
 * `packages/gazetta/src/archive/index.ts`).
 */
export interface ModuleFingerprint {
  path: string
}

/** Reason categories — drives which path the bot takes on subsequent runs. */
export type SkipReason =
  /** Generated code, third-party shims, no-runtime modules. Permanent. */
  | 'never-mutate'
  /** Bot proposed it; maintainer closed the PR. Durable until lessons compact it. */
  | 'maintainer-rejected'
  /** Free-text reason — used when none of the above categories fit. */
  | 'other'

export interface SkipEntry {
  fingerprint: ModuleFingerprint
  reason: SkipReason
  reasonNote: string
  addedAt: string
  addedBy: 'bot' | 'maintainer'
  /** When reason='maintainer-rejected', the PR number whose close drove the entry. */
  refPR?: number
}

export interface SkipRule {
  /** Glob pattern matched against module path. */
  scope: string
  reason: SkipReason
  reasonNote: string
  addedAt: string
  addedBy: 'bot' | 'maintainer'
}

export interface SkipList {
  version: 1
  entries: SkipEntry[]
  rules: SkipRule[]
}

export const SKIP_LIST_PATH = 'bots/mutation-area-picker/skip-list.json'

export function emptySkipList(): SkipList {
  return { version: 1, entries: [], rules: [] }
}

export function readSkipList(absolutePath: string): SkipList {
  if (!existsSync(absolutePath)) return emptySkipList()
  try {
    const parsed = JSON.parse(readFileSync(absolutePath, 'utf-8'))
    if (parsed?.version === 1 && Array.isArray(parsed.entries) && Array.isArray(parsed.rules)) {
      return parsed as SkipList
    }
  } catch {
    // fall through to empty
  }
  return emptySkipList()
}

export function writeSkipList(absolutePath: string, list: SkipList): void {
  writeFileSync(absolutePath, `${JSON.stringify(list, null, 2)}\n`)
}

/**
 * Return the matching entry or rule for the given fingerprint, or
 * null when neither matches. Entries take precedence over rules
 * (per-module > per-glob).
 */
export function findSkipMatch(list: SkipList, fp: ModuleFingerprint): SkipEntry | SkipRule | null {
  for (const entry of list.entries) {
    if (entry.fingerprint.path === fp.path) return entry
  }
  for (const rule of list.rules) {
    if (globMatches(rule.scope, fp.path)) return rule
  }
  return null
}

/**
 * Glob matcher supporting `*` (single segment) and `**` (any depth).
 * Same semantics as the other bots' skip-list globs. Brace
 * expansion (`{a,b}`) is intentionally NOT supported — keep the
 * matcher simple; use multiple rules when a brace would be needed.
 */
export function globMatches(pattern: string, path: string): boolean {
  // Token-by-token: escape regex metacharacters EXCEPT our glob
  // tokens. `**` matches any path including separators (with optional
  // trailing slash consumed so `src/**/*.ts` matches `src/foo.ts`
  // AND `src/x/foo.ts`); `*` matches a single segment.
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*'
      i += 2
      // Consume the trailing slash so `foo/**/bar` matches `foo/bar`
      if (pattern[i] === '/') i++
    } else if (c === '*') {
      regex += '[^/]*'
      i++
    } else if ('.+?^$()|[]\\{}'.includes(c)) {
      regex += `\\${c}`
      i++
    } else {
      regex += c
      i++
    }
  }
  return new RegExp(`^${regex}$`).test(path)
}

/**
 * Append an entry to the skip-list, deduping by fingerprint path.
 * Returns true if the entry was added; false if a duplicate existed.
 */
export function appendEntry(list: SkipList, entry: SkipEntry): boolean {
  const exists = list.entries.some(e => e.fingerprint.path === entry.fingerprint.path)
  if (exists) return false
  list.entries.push(entry)
  return true
}
