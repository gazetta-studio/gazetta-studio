/**
 * Claude Code CLI wrapper for bots.
 *
 * Bots delegate the "intelligent" part of their work to a headless `claude -p`
 * invocation. The orchestration (data plumbing, dedup, action) stays in TS;
 * the prompt-driven analysis and tool-call sequence belongs to Claude.
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN env var. The Claude Code CLI reads it
 * automatically — no flag needed. Bills against the Claude account's
 * subscription rather than per-token API spend.
 *
 * Transparency: Claude is invoked with `--output-format stream-json --verbose`
 * so every tool call, tool result, and assistant message lands as one JSON
 * event per line. The wrapper writes the raw JSONL to a transcript file (for
 * a future agent to read) AND renders a human-readable summary to stdout
 * (for live workflow log viewing). See `bots/README.md` "Improving the bot"
 * for how the transcripts feed the replay loop.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PendingTool, type RenderCounters, renderSummaryLine } from './claude-render.js'

/**
 * Repo root, derived from this file's location: bots/_lib/claude.ts → ../../
 *
 * Default cwd for spawned `claude` processes. Without this, npm-run lands the
 * script in `bots/`, and Claude's relative-path tool calls (cat docs/...,
 * grep ROADMAP.md) miss — costing 2-5 wasted retries per investigation.
 * Verified live on triage-bot run 25630679446: docs/non-goals.md was opened
 * 92 times across 44 investigations because relative paths kept failing.
 */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..')

export interface ClaudeOptions {
  /** The prompt content (system + user combined). */
  prompt: string
  /**
   * Tools Claude is allowed to invoke. Default `['Bash']` — most bots only
   * need to shell out to gh CLI. Pass `['Bash', 'Read']` if Claude also
   * needs to read repo files, etc.
   */
  allowedTools?: string[]
  /**
   * Working directory for tool calls. Defaults to the repo root (derived from
   * this file's location) so Claude's relative paths land in the project tree
   * rather than in `bots/` (where npm-run leaves the script).
   */
  cwd?: string
  /**
   * Path to write the raw JSONL transcript to. Required — agents replaying
   * past investigations read transcripts; if you don't want one, you don't
   * want this wrapper.
   */
  transcriptPath: string
  /**
   * Model to use. Defaults to `DEFAULT_MODEL` below — Opus 4.7 with 1M
   * context. Override per-call to use a smaller / cheaper model when the
   * task is small.
   *
   * Pass either an alias (`'opus'`, `'sonnet'`, `'haiku'`) which resolves
   * to the latest model in that line, or a full model ID like
   * `'claude-opus-4-7[1m]'`. The `[1m]` bracket suffix selects the 1M
   * context window for models that support it; without the suffix you
   * get the default 200K window.
   */
  model?: string
}

/**
 * Default model for all bot Claude invocations: Opus 4.7 with the 1M
 * context window.
 *
 * Why Opus 4.7 [1m]: bots routinely read multiple source files + tests +
 * issue bodies (fix-bot reads 30-50KB; mutation-watcher consumes a
 * pre-parsed summary but Claude still reads source files to ground fix
 * recommendations). Sonnet 4.6 (200K — the CLI default) blew the
 * context window on fix-bot's first dispatch against
 * `publish-rendered.ts` (22.7KB × 6 re-reads → autocompact thrash, run
 * 25639089938 exit 1 with no work product).
 *
 * Cost note: Opus is more expensive per-token, but bots run 1-2 times
 * per cron and read ~30-50KB. The dollar cost is cents per call. The
 * alternative (Sonnet 4.6) is the bot failing entirely, wasting the
 * full attempt — net more expensive. See team-preferences.md rule 21
 * on capturing this kind of operational lesson.
 */
const DEFAULT_MODEL = 'claude-opus-4-7[1m]'

export interface ClaudeResult {
  /** Exit code from the claude binary. 0 = success. */
  exitCode: number
  /** True when claude exited 0. */
  success: boolean
  /** Path the JSONL transcript was written to. */
  transcriptPath: string
}

/**
 * Run `claude -p` headless. Writes raw JSONL transcript to disk; renders a
 * human-readable summary to stdout in real time.
 *
 * Live-rendering rules + stream-json event types live in `./claude-render.ts`
 * (split for unit-testability). This wrapper owns process orchestration:
 * spawn, transcript IO, child stdio buffering, exit-code translation. Per
 * line of JSONL stdout we write to the transcript verbatim AND pass to
 * `renderSummaryLine` for the human-readable summary.
 *
 * Flag rationale:
 *   --print                       : non-interactive, exit after response
 *   --output-format stream-json   : emit one JSON event per line — required
 *                                   for the transcript + summary split
 *   --verbose                     : required alongside stream-json (CLI
 *                                   refuses without it)
 *   --model <id>                  : Opus 4.7 with 1M context by default —
 *                                   see DEFAULT_MODEL below for rationale
 *   --allowedTools <list>         : restrict to tools the prompt needs
 *   --dangerously-skip-permissions: no human in CI to approve tool calls;
 *                                   --allowedTools is the safety boundary
 *
 * Do NOT pass --bare — it disables OAuth token reading per the CLI docs.
 */
export async function runClaude(opts: ClaudeOptions): Promise<ClaudeResult> {
  const tools = opts.allowedTools ?? ['Bash']
  const model = opts.model ?? DEFAULT_MODEL
  await mkdir(dirname(opts.transcriptPath), { recursive: true })
  const transcript = createWriteStream(opts.transcriptPath, { flags: 'w' })

  // Per-call rendering state. Pending tool calls indexed by tool_use_id so
  // the matching tool_result can backfill duration + size. Counters drive
  // the final summary line.
  const pending = new Map<string, PendingTool>()
  const counters: RenderCounters = { toolCalls: 0, decisions: 0 }

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        model,
        '--allowedTools',
        tools.join(','),
        '--dangerously-skip-permissions',
        opts.prompt,
      ],
      { cwd: opts.cwd ?? REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] },
    )

    // Buffer stdout to handle JSONL events split across chunks. Each complete
    // line is parsed for the human summary AND written verbatim to the
    // transcript. Anything we can't parse is still preserved in the transcript.
    let stdoutBuffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8')
      let nlIndex = stdoutBuffer.indexOf('\n')
      while (nlIndex !== -1) {
        const line = stdoutBuffer.slice(0, nlIndex)
        stdoutBuffer = stdoutBuffer.slice(nlIndex + 1)
        if (line.trim()) {
          transcript.write(`${line}\n`)
          renderSummaryLine(line, pending, counters)
        }
        nlIndex = stdoutBuffer.indexOf('\n')
      }
    })

    child.on('error', err => {
      transcript.end()
      reject(err)
    })
    child.on('close', code => {
      // Flush any tail without trailing newline.
      if (stdoutBuffer.trim()) {
        transcript.write(`${stdoutBuffer}\n`)
        renderSummaryLine(stdoutBuffer, pending, counters)
      }
      transcript.end()
      const exitCode = code ?? 1
      resolve({ exitCode, success: exitCode === 0, transcriptPath: opts.transcriptPath })
    })
  })
}

/**
 * Detect whether a Claude transcript ended because of an Anthropic
 * session-rate-limit (5-hour bucket exhausted). Returns true iff the
 * transcript contains EITHER:
 *   - a `rate_limit_event` line with `status: 'rejected'` (the cascade
 *     case — every cut after the one that exhausted the bucket starts
 *     with this event before Claude even begins the conversation), OR
 *   - a `result` event with `api_error_status: 429` (the cut that
 *     actually hit the wall).
 *
 * Bots check this AFTER each Agent A invocation to decide whether to
 * STOP the candidate queue (rate-limited → tomorrow's cron retries) vs.
 * escalate this cut to `ready-for-human` (real failure). Without the
 * check, one 429 cascades into N spurious skip-list PRs as every
 * subsequent candidate crashes in 4s on the exhausted bucket.
 *
 * Discovered 2026-06-14, run 27493085111 — Cut #519 burned $35.29 over
 * 88 turns and hit the 5-hour limit; cuts #520, #524, #526 each crashed
 * in 4s producing PRs #587-#590 with reason `needs-human` that were in
 * fact transient rate-limit cascade victims.
 *
 * Defensive against missing / malformed transcripts: returns false on
 * any read or parse error. The caller's worst case in that branch is
 * "the bot escalates a cut it could have left on the queue" — strictly
 * less bad than the cascade we're preventing.
 */
export function detectRateLimit(transcriptPath: string): boolean {
  if (!existsSync(transcriptPath)) return false
  let content: string
  try {
    content = readFileSync(transcriptPath, 'utf-8')
  } catch {
    return false
  }
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const e = event as Record<string, unknown>
    if (e.type === 'rate_limit_event') {
      const info = e.rate_limit_info as { status?: string } | undefined
      if (info?.status === 'rejected') return true
    }
    if (e.type === 'result' && e.is_error === true && e.api_error_status === 429) {
      return true
    }
  }
  return false
}
