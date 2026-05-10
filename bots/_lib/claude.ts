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
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { c } from './colors.js'

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
 * Stream-json event shapes (only the fields we read).
 *
 * The schema isn't documented as stable — we use the minimum surface that
 * survives version bumps. Anything we don't recognise just falls through to
 * the raw transcript file.
 */
interface StreamEventBase {
  type: string
}
interface AssistantMessage extends StreamEventBase {
  type: 'assistant'
  message: {
    content: Array<
      { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown>; id: string }
    >
  }
}
interface UserMessage extends StreamEventBase {
  type: 'user'
  message: {
    content: Array<
      | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
      | { type: 'text'; text: string }
    >
  }
}
interface ResultEvent extends StreamEventBase {
  type: 'result'
  is_error: boolean
  result?: string
  duration_ms?: number
  num_turns?: number
}

/**
 * Run `claude -p` headless. Writes raw JSONL transcript to disk; renders a
 * human-readable summary to stdout in real time.
 *
 * Live-rendering rules (favors maintainer skim over completeness — full
 * detail is in the JSONL transcript):
 *
 *   - Tool call + result paired on one line:
 *       "  → Bash (4521 chars in 1.2s) gh issue view 245 ..."
 *     We track tool_use_id at the call site, then back-fill size + duration
 *     when the matching tool_result arrives. Avoids the dangling "← (N
 *     chars)" line that didn't tell you which call it belonged to.
 *
 *   - Decisions highlighted with "★ Decision: ..." — the prompts ask Claude
 *     to articulate WHY before non-trivial actions. Surfacing them means a
 *     maintainer scanning the log sees the reasoning trail at a glance.
 *
 *   - Other Claude text (acknowledgements, narration) is rendered as
 *     "▸ ..." but only the first line of any multi-line block. The rest
 *     lives in the transcript.
 *
 *   - Final result line summarises duration + turns + counts of tool
 *     calls and decisions, so a maintainer sees the shape of the
 *     investigation without scrolling.
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
  const pending = new Map<string, { name: string; summary: string; startedAt: number }>()
  const counters = { toolCalls: 0, decisions: 0 }

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
 * Render one stream-json line to a human-readable summary on stdout.
 *
 * Pairs tool_use with its matching tool_result via tool_use_id, so each
 * tool call shows on ONE line with backfilled size + duration:
 *
 *   🔧 Bash · 1.2s · 4.5KB · gh issue view 245 …
 *
 * Highlights "Decision: ..." text from Claude with a star prefix, since
 * the prompts ask for explicit decisions before non-trivial actions.
 * Other Claude text gets a quieter prefix so the decisions stand out.
 *
 * Format key (also see runClaude's docblock):
 *   🔧 <Tool> · <duration> · <size> · <args>      — paired tool call
 *   ★ Decision: <one sentence>                    — explicit decision log
 *   💬 <text>                                     — Claude narration
 *   ✅ done · <seconds>s · <turns> turns · ...    — final summary
 *   ❌ error after <seconds>s                      — final error
 *
 * Anything unrecognised is silently skipped from the summary; raw is in
 * the transcript regardless.
 */
interface PendingTool {
  name: string
  summary: string
  startedAt: number
}
interface RenderCounters {
  toolCalls: number
  decisions: number
}

function renderSummaryLine(line: string, pending: Map<string, PendingTool>, counters: RenderCounters): void {
  let event: StreamEventBase
  try {
    event = JSON.parse(line) as StreamEventBase
  } catch {
    return // Non-JSON line; raw is in transcript.
  }

  if (event.type === 'assistant') {
    const msg = event as AssistantMessage
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        renderClaudeText(block.text, counters)
      } else if (block.type === 'tool_use') {
        // Stash the call; we'll print it when the matching result arrives.
        pending.set(block.id, {
          name: block.name,
          summary: summarizeToolInput(block.name, block.input),
          startedAt: Date.now(),
        })
        counters.toolCalls++
      }
    }
  } else if (event.type === 'user') {
    const msg = event as UserMessage
    for (const block of msg.message.content) {
      if (block.type === 'tool_result') {
        const call = pending.get(block.tool_use_id)
        pending.delete(block.tool_use_id)
        const size = typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length
        const sizeStr = formatBytes(size)
        if (call) {
          const durationMs = Date.now() - call.startedAt
          const durationStr = formatDuration(durationMs)
          console.log(
            `   ${c.cyan('🔧')} ${c.bold(call.name)} ${c.dim('·')} ${c.dim(durationStr)} ${c.dim('·')} ${c.dim(sizeStr)} ${c.dim('·')} ${c.gray(call.summary)}`,
          )
        } else {
          // Result with no matching call — shouldn't happen, but render.
          console.log(`   ${c.cyan('🔧')} ${c.dim(`(orphaned result, ${sizeStr})`)}`)
        }
      }
    }
  } else if (event.type === 'result') {
    const r = event as ResultEvent
    const seconds = r.duration_ms ? Math.round(r.duration_ms / 1000) : 0
    if (r.is_error) {
      console.log(`   ${c.red('❌')} Claude error after ${c.bold(`${seconds}s`)}`)
    } else {
      const turns = r.num_turns ?? 0
      const stats = `${counters.toolCalls} tool call${counters.toolCalls === 1 ? '' : 's'}, ${counters.decisions} decision${counters.decisions === 1 ? '' : 's'}`
      console.log(
        `   ${c.green('✅')} done ${c.dim('·')} ${c.bold(`${seconds}s`)} ${c.dim('·')} ${c.bold(`${turns} turns`)} ${c.dim('·')} ${c.dim(stats)}`,
      )
    }
  }
}

/**
 * Render a Claude text block. Decisions get a star and color; other text
 * is dimmed and folded to its first line (full text is in transcript).
 */
function renderClaudeText(text: string, counters: RenderCounters): void {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length === 0) return

  for (const line of lines) {
    const decision = line.match(/^>?\s*Decision:\s*(.+)$/i)
    if (decision) {
      console.log(`   ${c.yellow('★')} ${c.bold('Decision:')} ${decision[1]}`)
      counters.decisions++
      continue
    }
    // Skip pure markdown-quote prefixes like "> *This was generated...*"
    // (the disclaimer that gets posted to issues — not maintainer-facing).
    if (line.startsWith('> *This was generated by AI')) continue

    // Non-decision narration: render the first non-trivial line, dimmed,
    // truncated. If Claude has multi-paragraph reasoning, only the lead
    // shows; the rest is in the transcript.
    if (!decision) {
      console.log(`   ${c.dim('💬')} ${c.dim(truncate(line, 140))}`)
      // Only the first non-decision line per text block — keeps live log
      // tight. Subsequent narration is captured in the transcript.
      break
    }
  }
}

/**
 * Trim a tool-call's input to a one-line summary. The full input is in the
 * transcript; this is for the live log skim.
 */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && typeof input.command === 'string') {
    return truncate(input.command, 120)
  }
  if (name === 'Read' && typeof input.file_path === 'string') {
    return input.file_path
  }
  if (name === 'Grep' && typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : ''
    return `${input.pattern}${path}`
  }
  if (name === 'Glob' && typeof input.pattern === 'string') {
    return input.pattern
  }
  if (name === 'Write' && typeof input.file_path === 'string') {
    return input.file_path
  }
  if (name === 'Edit' && typeof input.file_path === 'string') {
    return input.file_path
  }
  // Generic fallback: stringify, truncate.
  return truncate(JSON.stringify(input), 120)
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
