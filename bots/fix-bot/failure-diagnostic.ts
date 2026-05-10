/**
 * When `runClaude` exits non-zero, fix-bot's orchestrator mines the
 * transcript for a maintainer-readable failure summary, posts it on the
 * issue, and applies `ready-for-human` so the candidate isn't picked up
 * again next cron.
 *
 * Without this, fix-bot failures leave the issue in an ambiguous state
 * (no comment, no label change) — indistinguishable from "never tried"
 * even though work was attempted. Fix-bot run 25639089938 (against
 * #308) exited 1 from autocompact thrash with zero issue-side signal;
 * recovery required a human reading workflow logs to figure out what
 * happened.
 *
 * The transcript is a JSONL stream of stream-json events from the
 * Claude Code CLI. We extract the last `result` event (terminal status
 * + duration) and any trailing `assistant` text before it (Claude's
 * own self-diagnosis, e.g. "Autocompact is thrashing…"). Together,
 * those two pieces give a maintainer enough signal to act.
 */
import { readFileSync } from 'node:fs'

export interface FailureDiagnostic {
  /** True when the transcript's terminal `result` event was an error. */
  isError: boolean
  /** Number of conversation turns Claude completed before exit. */
  numTurns: number | null
  /** Wall-clock duration of the Claude call, in seconds. */
  durationSec: number | null
  /**
   * Human-readable failure category derived from the transcript shape.
   * Examples: "autocompact thrashed", "exit before any tool call",
   * "exited mid-task", "transcript empty".
   */
  category: string
  /**
   * Claude's last assistant text message, truncated. Often contains
   * a self-diagnostic line that's the most useful single signal.
   */
  lastAssistantText: string | null
}

const MAX_TEXT_LEN = 500

/**
 * Read the transcript JSONL and synthesise a FailureDiagnostic. Designed
 * to be tolerant of partial / truncated transcripts (which is exactly
 * the case when Claude crashed mid-stream).
 */
export function diagnoseFailure(transcriptPath: string): FailureDiagnostic {
  let lines: string[]
  try {
    lines = readFileSync(transcriptPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
  } catch {
    return {
      isError: true,
      numTurns: null,
      durationSec: null,
      category: 'transcript-unreadable',
      lastAssistantText: null,
    }
  }

  if (lines.length === 0) {
    return {
      isError: true,
      numTurns: null,
      durationSec: null,
      category: 'transcript-empty',
      lastAssistantText: null,
    }
  }

  // Walk events, tracking the most recent `result` and the most recent
  // assistant `text` block. Tolerate parse errors line-by-line — a
  // single malformed event shouldn't tank the whole diagnostic.
  interface ResultEvent {
    is_error?: boolean
    num_turns?: number
    duration_ms?: number
  }
  let lastResult: ResultEvent | null = null
  let lastAssistantText: string | null = null
  let toolCallCount = 0

  for (const line of lines) {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'result') {
      lastResult = event as ResultEvent
    } else if (event.type === 'assistant') {
      const message = event.message as { content?: Array<{ type: string; text?: string }> } | undefined
      const blocks = message?.content ?? []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          lastAssistantText = block.text
        }
        if (block.type === 'tool_use') {
          toolCallCount++
        }
      }
    }
  }

  const isError = lastResult?.is_error ?? true
  const numTurns = lastResult?.num_turns ?? null
  const durationSec = lastResult?.duration_ms ? Math.round(lastResult.duration_ms / 1000) : null
  const text = lastAssistantText ? truncate(lastAssistantText.trim(), MAX_TEXT_LEN) : null

  let category: string
  if (text?.toLowerCase().includes('autocompact')) {
    category = 'autocompact-thrashed'
  } else if (toolCallCount === 0) {
    category = 'exited-before-any-tool-call'
  } else if (!lastResult) {
    category = 'transcript-truncated-no-result-event'
  } else {
    category = 'exited-mid-task'
  }

  return { isError, numTurns, durationSec, category, lastAssistantText: text }
}

/**
 * Format a FailureDiagnostic as the body of an issue comment. Includes
 * the AI-disclaimer prefix + outcome tag per the project-wide convention.
 */
export function formatFailureComment(opts: {
  diagnostic: FailureDiagnostic
  workflowRunUrl: string
  runId: string
}): string {
  const { diagnostic, workflowRunUrl, runId } = opts

  const turnsLine = diagnostic.numTurns !== null ? `${diagnostic.numTurns} turn(s)` : 'unknown turns'
  const durationLine = diagnostic.durationSec !== null ? `${diagnostic.durationSec}s` : 'unknown duration'
  const textBlock = diagnostic.lastAssistantText
    ? `\n**Last message from Claude:**\n\n> ${diagnostic.lastAssistantText.split('\n').join('\n> ')}\n`
    : ''

  return `> *This was generated by AI during triage.*

⚠ **Fix-bot attempted but did not complete.**

- Failure mode: \`${diagnostic.category}\`
- Claude ran for ${durationLine}, ${turnsLine} before exit
- Workflow run: ${workflowRunUrl}
${textBlock}
**Maintainer next steps:**

1. **Read the workflow log** at the link above to see the full trace
2. If autocompact-thrashed: the issue's surface is too large for
   the bot's context. Consider splitting into smaller scoped issues
3. If exited-before-any-tool-call: bot config or prompt regression;
   check bots/fix-bot/prompt.md for recent changes
4. To re-attempt: delete this comment AND the prior fix-bot comment
   (if any), remove \`ready-for-human\`, the next cron picks up

\`ready-for-human\` is applied so this issue is removed from
fix-bot's automatic queue until you intervene.

<!-- fix-bot: run=${runId} status=failed category=${diagnostic.category} -->
`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}
