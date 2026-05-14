/**
 * Skip-list — durable memory for dead-code-watcher's "don't try this
 * again" decisions.
 *
 * Two shapes coexist in one JSON file:
 *
 *   - **entries**: specific `{ fingerprint, reason, ... }` per-finding
 *     decisions. Maintainer-friendly granularity; one entry per
 *     concretely-decided finding.
 *
 *   - **rules**: compacted generalisations the monthly compact-bot
 *     produces. Each rule has a `scope` (glob) + `reason` and matches
 *     ANY finding whose path satisfies the glob. Rules collapse N
 *     entries that share a pattern into one durable predicate.
 *
 * Both are read every weekly run; a finding is skipped if EITHER
 * matches. Both are written via PRs (no direct main commits per
 * team-preferences rule 33). The weekly bot adds entries; the
 * monthly compact-bot replaces entries with rules.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * Fingerprint shape — uniquely identifies one knip finding.
 *
 *   - kind: which knip issue category produced this finding
 *   - path: source file (relative to repo root)
 *   - symbol: export/type name (only for kind=export/type/enumMember)
 */
export interface Fingerprint {
  kind: 'file' | 'export' | 'type' | 'dependency' | 'devDependency' | 'enumMember'
  path: string
  symbol?: string
}

/** Reason categories — drives which path Claude takes on subsequent runs. */
export type SkipReason =
  /** Public package API consumed by external sites — keep forever. */
  | 'public-api'
  /** Used dynamically (worker thread, URL string, dynamic import). */
  | 'dynamic-load'
  /** Intentional planned-feature stub. */
  | 'planned-feature'
  /** Maintainer rejected the delete-PR with reasoning. */
  | 'maintainer-rejected'
  /** Bot tried, tests failed, needs human investigation. */
  | 'needs-human'
  /** Other — fall-through; reasonNote must explain. */
  | 'other'

export interface SkipEntry {
  fingerprint: Fingerprint
  reason: SkipReason
  /** Free-text explanation. Required when reason='other' or 'maintainer-rejected'. */
  reasonNote?: string
  /** When the entry was added. ISO-8601. */
  addedAt: string
  /** Who decided. Bot = compacted from feedback loop; maintainer = manual edit. */
  addedBy: 'bot' | 'maintainer'
  /** PR number that originated the decision (when addedBy=bot). */
  refPR?: number
}

export interface SkipRule {
  /** Stable identifier for diagnostics + compaction replays. */
  rule: string
  /**
   * Glob pattern matched against the finding's `path` (relative to
   * repo root). Standard glob: `*` matches segment, `**` matches any.
   * Examples:
   *   - `packages/gazetta/src/index.ts` (exact)
   *   - `packages/gazetta/src/**\/index.ts` (all entry points)
   *   - `examples/**\/*.config.ts` (all starter site configs)
   */
  scope: string
  /**
   * Optional finding-kind filter. When set, rule only matches findings
   * of these kinds. When omitted, matches any kind.
   */
  kinds?: Array<Fingerprint['kind']>
  /** Reason category — drives which Claude path runs on match. */
  reason: SkipReason
  reasonNote?: string
  /** When the rule was created. */
  addedAt: string
  /** Always 'bot' for rules (only compact-bot creates them). */
  addedBy: 'bot'
  /** Number of entries this rule replaced when compacted. */
  compactedFrom: number
}

export interface SkipList {
  version: 1
  entries: SkipEntry[]
  rules: SkipRule[]
}

/** Disk-storage path for the skip-list, relative to repo root. */
export const SKIP_LIST_PATH = 'bots/dead-code-watcher/skip-list.json'

/** Empty skip-list — shape used when seeding a fresh repo. */
export function emptySkipList(): SkipList {
  return { version: 1, entries: [], rules: [] }
}

/** Read the skip-list from disk. Returns empty skip-list if file doesn't exist. */
export function readSkipList(absolutePath: string): SkipList {
  if (!existsSync(absolutePath)) return emptySkipList()
  const raw = readFileSync(absolutePath, 'utf-8')
  const parsed = JSON.parse(raw) as SkipList
  if (parsed.version !== 1) {
    throw new Error(`Skip-list at ${absolutePath} has unknown version ${parsed.version}`)
  }
  return parsed
}

/** Write the skip-list back to disk, formatted for readable diffs. */
export function writeSkipList(absolutePath: string, list: SkipList): void {
  // 2-space indent matches Biome defaults; trailing newline matches POSIX.
  writeFileSync(absolutePath, `${JSON.stringify(list, null, 2)}\n`)
}

/**
 * Stable fingerprint string for equality + display.
 *
 *   kind=file → `file:packages/foo/bar.ts`
 *   kind=export → `export:packages/foo/bar.ts#myExport`
 */
export function formatFingerprint(fp: Fingerprint): string {
  return fp.symbol ? `${fp.kind}:${fp.path}#${fp.symbol}` : `${fp.kind}:${fp.path}`
}

/** True when two fingerprints describe the same finding. */
export function fingerprintsEqual(a: Fingerprint, b: Fingerprint): boolean {
  return a.kind === b.kind && a.path === b.path && a.symbol === b.symbol
}

/**
 * Match a finding's fingerprint against the skip-list.
 *
 * Checks entries (exact match) first, then rules (glob match). Returns
 * the first match found; both layers are functionally equivalent
 * "this is a skip" signal — the bot doesn't need to know which one matched
 * (the differentiation is for the compact-bot's analysis only).
 *
 * Returns null when no match found — the bot should investigate the
 * finding fresh.
 */
export function findSkipMatch(list: SkipList, fp: Fingerprint): SkipEntry | SkipRule | null {
  for (const entry of list.entries) {
    if (fingerprintsEqual(entry.fingerprint, fp)) return entry
  }
  for (const rule of list.rules) {
    if (rule.kinds && !rule.kinds.includes(fp.kind)) continue
    if (globMatches(rule.scope, fp.path)) return rule
  }
  return null
}

/**
 * Glob matcher — supports `*` (single segment), `**` (any path),
 * literal `?` (single char), and bracket expressions.
 *
 * Intentionally small — knip's fingerprints have simple path shapes
 * (no need for micromatch's full grammar). Tested against the actual
 * patterns we generate from compaction.
 *
 * Pattern semantics:
 *   - `foo/bar.ts` matches only that exact path
 *   - `foo/*.ts` matches any .ts file directly inside `foo/`
 *   - `foo/**\/bar.ts` matches `foo/bar.ts`, `foo/x/bar.ts`, etc.
 *   - `foo/**` matches any path under `foo/`
 */
export function globMatches(pattern: string, path: string): boolean {
  // Escape regex metacharacters EXCEPT our glob tokens.
  // Build a regex by replacing tokens with their regex equivalents.
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      // ** — match any path including separators
      regex += '.*'
      i += 2
      // Consume trailing `/` so `foo/**/bar` matches `foo/bar` AND `foo/x/bar`
      if (pattern[i] === '/') i++
    } else if (c === '*') {
      // * — match anything except path separators
      regex += '[^/]*'
      i++
    } else if (c === '?') {
      regex += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(c)) {
      // Regex metacharacter — escape
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
 * Append a fresh entry to the skip-list. Idempotent: if an entry with
 * the same fingerprint already exists, the existing one is kept
 * unchanged. The caller does NOT need to dedup before calling.
 *
 * Returns true when a new entry was added, false when one already
 * existed.
 */
export function appendEntry(list: SkipList, entry: SkipEntry): boolean {
  const existing = list.entries.find(e => fingerprintsEqual(e.fingerprint, entry.fingerprint))
  if (existing) return false
  list.entries.push(entry)
  return true
}
