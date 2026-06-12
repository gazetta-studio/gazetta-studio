/**
 * Stream-json renderer for the Claude Code CLI output.
 *
 * Pure logic: given a single JSONL line emitted by `claude --output-format
 * stream-json`, render a human-readable summary line via an injected logger.
 * Process orchestration (spawn, transcript IO, child stdio events) lives in
 * `./claude.js` — split out so the rendering pipeline can be unit-tested
 * without spawning a child process.
 *
 * Live-rendering rules (favors maintainer skim over completeness — full
 * detail is in the JSONL transcript):
 *
 *   - Tool call + result paired on one line, keyed by tool_use_id at the
 *     call site then back-filled with size + duration when the matching
 *     tool_result arrives. Avoids the dangling "← (N chars)" line that
 *     didn't tell you which call it belonged to.
 *
 *   - Decisions highlighted with "★ Decision: ..." — the prompts ask Claude
 *     to articulate WHY before non-trivial actions. Surfacing them means a
 *     maintainer scanning the log sees the reasoning trail at a glance.
 *
 *   - Other Claude text rendered as "💬 ..." but only the first non-empty
 *     line of any multi-line block. The rest lives in the transcript.
 *
 *   - Final `result` event summarises duration + turns + counts of tool
 *     calls and decisions, so a maintainer sees the shape of the
 *     investigation without scrolling.
 */
import { c } from './colors.js'

/** Logger sink. Defaults to `console.log` at every call site. */
export type LogFn = (line: string) => void

/**
 * Stream-json event shapes (only the fields we read).
 *
 * The schema isn't documented as stable — we use the minimum surface that
 * survives version bumps. Anything we don't recognise just falls through to
 * the raw transcript file.
 */
export interface StreamEventBase {
  type: string
}
export interface AssistantMessage extends StreamEventBase {
  type: 'assistant'
  message: {
    content: Array<
      { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown>; id: string }
    >
  }
}
export interface UserMessage extends StreamEventBase {
  type: 'user'
  message: {
    content: Array<
      | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
      | { type: 'text'; text: string }
    >
  }
}
export interface ResultEvent extends StreamEventBase {
  type: 'result'
  is_error: boolean
  result?: string
  duration_ms?: number
  num_turns?: number
}

/** Per-call pending state. Tool calls indexed by tool_use_id so the matching
 *  tool_result can backfill duration + size. */
export interface PendingTool {
  name: string
  summary: string
  startedAt: number
}
/** Per-call counters. Drive the final summary line. */
export interface RenderCounters {
  toolCalls: number
  decisions: number
}

/**
 * Render one stream-json line to a human-readable summary via `log`.
 *
 * Format key:
 *   🔧 <Tool> · <duration> · <size> · <args>      — paired tool call
 *   ★ Decision: <one sentence>                    — explicit decision log
 *   💬 <text>                                     — Claude narration
 *   ✅ done · <seconds>s · <turns> turns · ...    — final summary
 *   ❌ error after <seconds>s                      — final error
 *
 * Anything unrecognised is silently skipped from the summary; raw is in
 * the transcript regardless.
 */
export function renderSummaryLine(
  line: string,
  pending: Map<string, PendingTool>,
  counters: RenderCounters,
  log: LogFn = console.log,
): void {
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
        renderClaudeText(block.text, counters, log)
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
          log(
            `   ${c.cyan('🔧')} ${c.bold(call.name)} ${c.dim('·')} ${c.dim(durationStr)} ${c.dim('·')} ${c.dim(sizeStr)} ${c.dim('·')} ${c.gray(call.summary)}`,
          )
        } else {
          // Result with no matching call — shouldn't happen, but render.
          log(`   ${c.cyan('🔧')} ${c.dim(`(orphaned result, ${sizeStr})`)}`)
        }
      }
    }
  } else if (event.type === 'result') {
    const r = event as ResultEvent
    const seconds = r.duration_ms ? Math.round(r.duration_ms / 1000) : 0
    if (r.is_error) {
      log(`   ${c.red('❌')} Claude error after ${c.bold(`${seconds}s`)}`)
    } else {
      const turns = r.num_turns ?? 0
      const stats = `${counters.toolCalls} tool call${counters.toolCalls === 1 ? '' : 's'}, ${counters.decisions} decision${counters.decisions === 1 ? '' : 's'}`
      log(
        `   ${c.green('✅')} done ${c.dim('·')} ${c.bold(`${seconds}s`)} ${c.dim('·')} ${c.bold(`${turns} turns`)} ${c.dim('·')} ${c.dim(stats)}`,
      )
    }
  }
}

/**
 * Render a Claude text block. Decisions get a star and color; other text
 * is dimmed and folded to its first line (full text is in transcript).
 */
export function renderClaudeText(text: string, counters: RenderCounters, log: LogFn = console.log): void {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length === 0) return

  for (const line of lines) {
    const decision = line.match(/^>?\s*Decision:\s*(.+)$/i)
    if (decision) {
      log(`   ${c.yellow('★')} ${c.bold('Decision:')} ${decision[1]}`)
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
      log(`   ${c.dim('💬')} ${c.dim(truncate(line, 140))}`)
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
export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
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

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
