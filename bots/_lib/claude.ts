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
import { dirname } from 'node:path'

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
   * Working directory for tool calls. Default `process.cwd()`.
   */
  cwd?: string
  /**
   * Path to write the raw JSONL transcript to. Required — agents replaying
   * past investigations read transcripts; if you don't want one, you don't
   * want this wrapper.
   */
  transcriptPath: string
}

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
 * Flag rationale:
 *   --print                       : non-interactive, exit after response
 *   --output-format stream-json   : emit one JSON event per line — required
 *                                   for the transcript + summary split
 *   --verbose                     : required alongside stream-json (CLI
 *                                   refuses without it)
 *   --allowedTools <list>         : restrict to tools the prompt needs
 *   --dangerously-skip-permissions: no human in CI to approve tool calls;
 *                                   --allowedTools is the safety boundary
 *
 * Do NOT pass --bare — it disables OAuth token reading per the CLI docs.
 */
export async function runClaude(opts: ClaudeOptions): Promise<ClaudeResult> {
  const tools = opts.allowedTools ?? ['Bash']
  await mkdir(dirname(opts.transcriptPath), { recursive: true })
  const transcript = createWriteStream(opts.transcriptPath, { flags: 'w' })

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        tools.join(','),
        '--dangerously-skip-permissions',
        opts.prompt,
      ],
      { cwd: opts.cwd ?? process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'inherit'] },
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
          renderSummaryLine(line)
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
        renderSummaryLine(stdoutBuffer)
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
 * Format conventions:
 *   - Tool calls:   "→ Bash: gh issue list ..."  (truncated args)
 *   - Tool results: "  ← (123 chars)"            (size only — full content
 *                                                 is in the transcript)
 *   - Text output:  "▸ ..."                     (Claude's natural-language
 *                                                 reasoning, decision logs)
 *   - Final result: "✓ done in 12s, 5 turns"     OR "✗ error after Ns"
 *
 * Anything unrecognised is silently skipped from the summary; raw is in the
 * transcript regardless.
 */
function renderSummaryLine(line: string): void {
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
        // Render multi-line text with each line prefixed for readability.
        for (const textLine of block.text.split('\n')) {
          if (textLine.trim()) console.log(`  ▸ ${textLine}`)
        }
      } else if (block.type === 'tool_use') {
        console.log(`  → ${block.name}: ${summarizeToolInput(block.name, block.input)}`)
      }
    }
  } else if (event.type === 'user') {
    const msg = event as UserMessage
    for (const block of msg.message.content) {
      if (block.type === 'tool_result') {
        const size = typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length
        console.log(`    ← (${size} chars)`)
      }
    }
  } else if (event.type === 'result') {
    const r = event as ResultEvent
    const seconds = r.duration_ms ? Math.round(r.duration_ms / 1000) : '?'
    if (r.is_error) {
      console.log(`  ✗ Claude reported error after ${seconds}s`)
    } else {
      console.log(`  ✓ done in ${seconds}s, ${r.num_turns ?? '?'} turns`)
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
  // Generic fallback: stringify, truncate.
  return truncate(JSON.stringify(input), 120)
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
