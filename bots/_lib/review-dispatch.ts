/**
 * Code-review skill dispatch — map a diff to the angle skills that should run.
 *
 * Owns the path-glob classification side of the producer/consumer split
 * (per `bots/README.md` "Producer vs consumer" + ADR-0013). Given the list
 * of files changed in a diff, decide which Phase 2 evaluation skills to
 * invoke. Returns angle names in stable order; the orchestrator skill body
 * spawns them as parallel sub-agents.
 *
 * Single source of truth for the dispatch table. The executable entry at
 * `.claude/skills/review-orchestrator/dispatch.ts` re-exports this; the
 * orchestrator SKILL.md documents the table in prose. Three places, one
 * implementation.
 *
 * See design-code-review.md "Dispatch" section.
 */

export type Angle =
  | 'review-diff'
  | 'review-architecture'
  | 'review-security'
  | 'review-tests'
  | 'review-types'
  | 'review-comments'

export const ALL_ANGLES: readonly Angle[] = [
  'review-diff',
  'review-architecture',
  'review-security',
  'review-tests',
  'review-types',
  'review-comments',
] as const

/**
 * Input to dispatch — a list of changed files plus optional content slices.
 *
 * Content slices are used only for fine-grained checks (e.g., "does this
 * diff add a `z.object(...)` call?" for review-types). Most checks operate
 * on `path` alone.
 */
export interface DispatchInput {
  files: readonly DispatchFile[]
}

export interface DispatchFile {
  /** Repo-relative path. */
  path: string
  /** Status from `git diff --name-status` (`A` / `M` / `D` / etc.). Optional. */
  status?: 'added' | 'modified' | 'deleted' | 'renamed'
  /**
   * Content slice for fine-grained checks. Optional — when omitted, only
   * path-based rules fire. The orchestrator can provide the unified diff
   * or the post-change file content; the patterns we match against are
   * substring patterns that work in either form.
   */
  content?: string
}

/**
 * Dispatch a diff to the list of angle skills that should run.
 *
 * Algorithm:
 *   1. `review-diff` always fires (general baseline; cheapest pass).
 *   2. For each angle's path patterns, fire the angle when any file matches.
 *   3. For each angle's content patterns, fire when any file's content
 *      contains the pattern.
 *   4. Dedupe; preserve stable order from `ALL_ANGLES`.
 *
 * Order matters only for human readability of the angle list and replay-loop
 * diff stability — not for the parallel-spawn behavior in the orchestrator.
 */
export function dispatch(input: DispatchInput): Angle[] {
  const fired = new Set<Angle>(['review-diff'])

  for (const file of input.files) {
    if (matchesTests(file)) fired.add('review-tests')
    if (matchesTypes(file)) fired.add('review-types')
    if (matchesArchitecture(file)) fired.add('review-architecture')
    if (matchesSecurity(file)) fired.add('review-security')
    if (matchesComments(file)) fired.add('review-comments')
  }

  return ALL_ANGLES.filter((a) => fired.has(a))
}

// --- Per-angle matchers -------------------------------------------------
//
// Each matcher returns true when the file's path or content indicates this
// angle should run. Matchers are exported individually so the test suite
// can validate each row of the dispatch table in isolation.

/**
 * Fires when the file looks like a test or test-helper.
 *
 * Patterns (per `testing-plan.md` test file layout):
 *   - `tests/...` directories
 *   - `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`
 *   - `tests/_helpers/...`
 */
export function matchesTests(file: DispatchFile): boolean {
  const p = file.path
  if (/(^|\/)tests?\//.test(p)) return true
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(p)) return true
  return false
}

/**
 * Fires when the diff introduces or modifies type definitions.
 *
 * Path-based check is too coarse here (every `.ts` file COULD contain
 * types); we require a content pattern indicating a type-shape declaration.
 * If content is unavailable, we fire only on files in directories that
 * primarily own type definitions.
 */
export function matchesTypes(file: DispatchFile): boolean {
  if (file.content) {
    // Common type-introduction patterns: Zod schemas, TS type aliases,
    // interfaces, branded types, discriminated unions.
    if (/\bz\.(object|union|discriminatedUnion|enum|literal|tuple|record)\s*\(/.test(file.content)) return true
    if (/\binterface\s+[A-Z]\w*\s*[\{<]/.test(file.content)) return true
    if (/\btype\s+[A-Z]\w*\s*=/.test(file.content)) return true
  }
  // Files whose primary content is type definitions (heuristic).
  if (/\/types\.ts$/.test(file.path)) return true
  if (/\/schemas\//.test(file.path)) return true
  return false
}

/**
 * Fires when the diff touches foundational architecture surfaces.
 *
 * Path patterns:
 *   - Foundational gazetta src directories (audit, validation, hooks,
 *     auth, review, scheduling, soft-delete) — these implement the
 *     13 foundational dimensions per feature-design-process.md.
 *   - `.claude/rules/design-*.md` — modifying a design doc itself is
 *     architectural by definition.
 *   - `docs/adr/` — same.
 */
export function matchesArchitecture(file: DispatchFile): boolean {
  const p = file.path
  if (/^packages\/gazetta\/src\/(audit|validation|hooks|auth|review|scheduling|soft-delete)\//.test(p)) return true
  if (/^\.claude\/rules\/design-.*\.md$/.test(p)) return true
  if (/^docs\/adr\//.test(p)) return true
  return false
}

/**
 * Fires when the diff touches security-sensitive surfaces.
 *
 * Path patterns:
 *   - `admin-api/` — admin route surface (capability gates live here)
 *   - `providers/` — storage / transform / cache / AI providers
 *   - `sanitize`, `capability`, `auth` substrings in path
 *   - `package.json` changes (dependency bumps could carry CVEs)
 *
 * Content patterns:
 *   - URL fetching (`fetch(`, `axios.`, `http.get(`) — SSRF surface
 *   - Process exec (`child_process`, `exec(`, `spawn(`)
 */
export function matchesSecurity(file: DispatchFile): boolean {
  const p = file.path
  if (/\/admin-api\//.test(p)) return true
  if (/\/providers\//.test(p)) return true
  if (/sanitize/i.test(p)) return true
  if (/capability/i.test(p)) return true
  if (/(^|\/)auth(\/|\.)/i.test(p)) return true
  if (/(^|\/)package\.json$/.test(p)) return true
  if (file.content) {
    if (/\bfetch\s*\(/.test(file.content)) return true
    if (/\bchild_process\b/.test(file.content)) return true
    if (/\bexec\s*\(/.test(file.content)) return true
  }
  return false
}

/**
 * Fires when the diff is comment-only.
 *
 * Without content, we can't tell. With content, we check that every
 * non-whitespace added/removed line starts with a comment marker.
 * This intentionally errs on the side of NOT firing — review-comments
 * is cheap to skip, expensive (noisy) to fire spuriously.
 */
export function matchesComments(file: DispatchFile): boolean {
  if (!file.content) return false
  // Detect change lines (diff +/-) that contain only comments.
  // We accept: //, /* */, * (continuation), #, <!-- -->.
  const changeLines = file.content
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^[+-]{3}\s/.test(l)) // skip diff headers
  if (changeLines.length === 0) return false
  return changeLines.every((l) => {
    const body = l.slice(1).trim()
    if (body === '') return true // blank line
    return /^(\/\/|\/\*|\*|#|<!--)/.test(body) || /-->$/.test(body) || /\*\/$/.test(body)
  })
}

// --- CLI entry ----------------------------------------------------------
//
// When run as a script (via tsx), reads `git diff --name-status` from
// the args' base, builds DispatchInput, and prints one angle name per
// line on stdout.
//
// Usage: tsx dispatch.ts [--base <ref>]
//   Default base is `HEAD` (uncommitted changes).
//   Specify `--base main` for branch-vs-main diff.

export async function cliMain(argv: readonly string[], spawn: SpawnLike): Promise<readonly Angle[]> {
  const baseIdx = argv.indexOf('--base')
  const base = baseIdx >= 0 ? (argv[baseIdx + 1] ?? 'HEAD') : 'HEAD'

  // git diff --name-status <base> emits "A\tpath" / "M\tpath" / "D\tpath" lines.
  const nameStatus = await spawn('git', ['diff', '--name-status', base])
  const files: DispatchFile[] = parseNameStatus(nameStatus)

  // For each file, optionally read its diff content for fine-grained checks.
  // Limit to first 50 files to keep this fast on large diffs.
  for (const file of files.slice(0, 50)) {
    if (file.status === 'deleted') continue
    try {
      file.content = await spawn('git', ['diff', base, '--', file.path])
    } catch {
      // ignore unreadable files
    }
  }

  return dispatch({ files })
}

export type SpawnLike = (cmd: string, args: readonly string[]) => Promise<string>

/** Parse `git diff --name-status` output into DispatchFile entries. */
export function parseNameStatus(output: string): DispatchFile[] {
  const files: DispatchFile[] = []
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const match = line.match(/^([AMDRT])\d*\t(.+?)(?:\t(.+))?$/)
    if (!match) continue
    const code = match[1]!
    const path = match[3] ?? match[2]! // for renames, the new path is in column 3
    files.push({ path, status: statusFromCode(code) })
  }
  return files
}

function statusFromCode(code: string): DispatchFile['status'] {
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return 'modified'
  }
}

// --- Script entry -------------------------------------------------------
//
// When invoked directly (via `tsx bots/_lib/review-dispatch.ts ...`),
// run cliMain and print each angle on its own line. Importing this file
// as a library does not trigger this block.

import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const isMain = import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  void (async () => {
    const execFileAsync = promisify(execFile)
    const spawn: SpawnLike = async (cmd, args) => {
      const { stdout } = await execFileAsync(cmd, [...args], { maxBuffer: 10 * 1024 * 1024 })
      return stdout
    }
    const angles = await cliMain(process.argv.slice(2), spawn)
    for (const a of angles) process.stdout.write(`${a}\n`)
  })()
}
