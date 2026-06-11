/**
 * Phase 0 data collection — fetch the raw signals the area-scorer needs.
 *
 * Each function is a thin shell over either git or gh; testable
 * separately via dependency-injected `runCmd` (matching the
 * SpawnLike pattern in review-dispatch.ts).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitFileTouch } from './area-scorer.js'

const execFileAsync = promisify(execFile)

export type RunCmd = (cmd: string, args: readonly string[]) => Promise<string>

const defaultRun: RunCmd = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, [...args], { maxBuffer: 50 * 1024 * 1024 })
  return stdout
}

/**
 * Collect file touches in the recency window via `git log`.
 *
 * Returns one entry per (path, most-recent-touch) — files touched
 * multiple times collapse to the most recent commit's date.
 */
export async function collectGitTouches(opts: { sinceDays?: number; run?: RunCmd } = {}): Promise<GitFileTouch[]> {
  const since = opts.sinceDays ?? 30
  const run = opts.run ?? defaultRun
  // `git log --since=` accepts both dates and relative expressions; we
  // use the relative form to avoid timezone surprises. --name-only
  // emits one file per line per commit; --pretty=format:'%cI' emits
  // committer ISO timestamps before each commit's filelist.
  const out = await run('git', ['log', `--since=${since} days ago`, '--name-only', '--pretty=format:COMMIT %cI'])
  return parseGitLogTouches(out)
}

/** Pure parser, testable in isolation. */
export function parseGitLogTouches(stdout: string): GitFileTouch[] {
  const latest = new Map<string, string>()
  let currentTs = ''
  for (const line of stdout.split('\n')) {
    if (line.startsWith('COMMIT ')) {
      currentTs = line.slice('COMMIT '.length).trim()
      continue
    }
    if (line.trim() === '') continue
    // Keep the most-recent observed timestamp (commits iterate newest
    // first in `git log`'s default order).
    if (!latest.has(line)) latest.set(line, currentTs)
  }
  return Array.from(latest.entries()).map(([path, lastTouchedAt]) => ({ path, lastTouchedAt }))
}

/**
 * Collect prior review-bot PRs grouped by area, via `gh pr list`.
 *
 * Returns a Map<area, mostRecentPRTimestamp>. Areas with no prior PR
 * are absent from the map (lookup returns undefined → Infinity in the
 * scorer's cold-on-bot calculation).
 *
 * Relies on the outcome-tag convention: every review-bot PR title
 * starts with `improve/`. We list all PRs (open + closed) authored
 * on `improve/*` branches in the last 6 months and group by area.
 */
export async function collectBotPRsByArea(
  opts: { run?: RunCmd; sinceDays?: number } = {},
): Promise<Map<string, string>> {
  const run = opts.run ?? defaultRun
  const sinceDays = opts.sinceDays ?? 180
  // gh pr list returns JSON; we ask for headRefName + createdAt.
  // --search uses a sub-query against the head ref pattern.
  const out = await run('gh', [
    'pr',
    'list',
    '--state',
    'all',
    '--search',
    `head:improve/`,
    '--limit',
    '200',
    '--json',
    'headRefName,createdAt',
  ])
  return parseBotPRs(out, sinceDays)
}

/**
 * Closed type enum from `Fingerprint['type']` (skip-list.ts). Branch
 * names start with one of these prefixes after `improve/`. Listed here
 * rather than imported to keep this module dependency-free and the
 * parser self-contained; drift caught by parseBotPRs's tests (which
 * round-trip through fingerprintToBranch).
 */
const CANDIDATE_TYPES = ['correctness', 'security', 'architecture', 'tests', 'types', 'comments', 'style'] as const

/** Pure parser for `gh pr list` JSON output. */
export function parseBotPRs(stdout: string, sinceDays: number): Map<string, string> {
  const out = new Map<string, string>()
  let prs: Array<{ headRefName?: string; createdAt?: string }>
  try {
    prs = JSON.parse(stdout) as typeof prs
  } catch {
    // Empty output / parse failure → no prior PRs; conservative empty map.
    return out
  }
  const cutoff = Date.now() - sinceDays * 86_400_000
  for (const pr of prs) {
    if (!pr.headRefName || !pr.createdAt) continue
    if (new Date(pr.createdAt).getTime() < cutoff) continue
    // Each branch may produce multiple candidate area keys when the
    // encoding is ambiguous (hyphenated dir names like `fix-bot`);
    // spurious keys are harmless because area-scorer only looks up
    // areas that exist in its own touch-counts map.
    for (const area of branchAreaCandidates(pr.headRefName)) {
      const prev = out.get(area)
      if (!prev || new Date(pr.createdAt).getTime() > new Date(prev).getTime()) {
        out.set(area, pr.createdAt)
      }
    }
  }
  return out
}

/**
 * Invert `fingerprintToBranch`'s encoding to recover the area path the
 * scorer queries.
 *
 * Branch shape (from `past-pr.ts#fingerprintToBranch`):
 *
 *   `improve/<type>-<encoded-area>-<rule-tail>`
 *
 *   - `<type>`: closed enum (no dashes)
 *   - `<encoded-area>`: path with `/` → `--`; segments may contain single dashes
 *   - `<rule-tail>`: alphanumeric + single dashes
 *
 * Returns every plausible area path for the branch. The encoded-area /
 * rule-tail boundary is genuinely ambiguous when an area segment contains
 * a dash (e.g., `bots/fix-bot/`), so we emit one candidate per `-` position
 * after the last `--`. Spurious candidates never match the scorer's
 * touch-counts map; the correct one wins.
 *
 * Returns `[]` when the branch doesn't match the improve/<known-type>- shape.
 */
export function branchAreaCandidates(headRefName: string): string[] {
  const m = headRefName.match(/^improve\/(.+)$/)
  if (!m) return []
  const ref = m[1]!

  let afterType: string | null = null
  for (const t of CANDIDATE_TYPES) {
    if (ref.startsWith(`${t}-`)) {
      afterType = ref.slice(t.length + 1)
      break
    }
  }
  if (afterType === null || afterType.length === 0) return []

  const chunks = afterType.split('--')
  if (chunks.length === 1) {
    // Depth-1 area (no `--` in encoded form): the single chunk holds
    // `<rootSeg>-<ruleTail>`. The first `-` separates them.
    const chunk = chunks[0]!
    const firstDash = chunk.indexOf('-')
    if (firstDash <= 0) return []
    return [`${chunk.slice(0, firstDash)}/`]
  }

  // Multi-chunk: middle chunks are path segments verbatim. The last chunk
  // is `<lastAreaSeg>-<ruleTail>`; the seg may itself contain dashes
  // (e.g., `fix-bot`), so enumerate every `-` position as a boundary.
  const headChunks = chunks.slice(0, -1)
  const lastChunk = chunks[chunks.length - 1]!
  const candidates: string[] = []
  let dashIdx = lastChunk.indexOf('-')
  while (dashIdx > 0) {
    const lastSeg = lastChunk.slice(0, dashIdx)
    candidates.push(`${[...headChunks, lastSeg].join('/')}/`)
    dashIdx = lastChunk.indexOf('-', dashIdx + 1)
  }
  return candidates
}

/** Parse the LLM picker's `PICK: <area>` final line. */
export function parsePickerOutput(text: string): { area: string | null; reasoning: string } {
  // Find the LAST line starting with `PICK:` (defensive — the prompt
  // may emit Decision lines first, then the final PICK).
  const lines = text.split('\n')
  let pickLine: string | null = null
  let pickIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^PICK:\s/.test(lines[i] ?? '')) {
      pickLine = lines[i]!
      pickIdx = i
      break
    }
  }
  if (!pickLine) return { area: null, reasoning: 'no PICK: line in picker output' }
  const value = pickLine.replace(/^PICK:\s*/, '').trim()
  if (value === 'NONE') {
    // Collect trailing reasoning lines.
    const reasoning = lines
      .slice(pickIdx + 1)
      .join('\n')
      .replace(/^Reasoning:\s*/, '')
      .trim()
    return { area: null, reasoning: reasoning || 'picker returned NONE' }
  }
  const reasoning = lines
    .slice(pickIdx + 1)
    .join('\n')
    .replace(/^Reasoning:\s*/, '')
    .trim()
  return { area: value, reasoning }
}
