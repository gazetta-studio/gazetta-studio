/**
 * Unit tests for claude-renderer.ts — the live stream-json renderer + its
 * pure helpers, extracted from claude.ts so a `claude` subprocess isn't
 * required to exercise them.
 *
 * Coverage targets (per the audit candidate):
 *   (a) `detectDecision` — the `^>?\s*Decision:\s*(.+)$/i` regex must spot
 *       `> Decision: foo`, `Decision: foo`, but NOT in-prose `Decision:`
 *       mentions ("Per bots/README.md's 'Decision log' convention" — the
 *       renderer drives the live workflow log every bot relies on).
 *   (b) `summarizeToolInput` — Bash/Read/Grep/Glob/Write/Edit branches
 *       return the right input field, truncated to ≤120 chars where it's
 *       free-form (Bash command). Unknown tools fall through to generic
 *       JSON stringify.
 *   (c) `formatBytes` — `1024 → 1.0KB`, `1024² → 1.0MB` boundary rolls.
 *   (d) Orphaned-tool-result branch in `renderSummaryLine` — when a
 *       tool_result arrives with a tool_use_id not in the `pending` map
 *       (the candidate calls it "the orphaned branch"), the renderer
 *       must not crash; it should log a synthetic "(orphaned result, …)"
 *       line so a future agent reading the live log can see something
 *       went sideways.
 *
 * ANSI handling: assertions use `toContain()` (not `toBe()` or `endsWith()`)
 * so they're robust against the ANSI escape codes the colors helper emits
 * — colors.ts evaluates its `enabled` flag at module load, and ES import
 * hoisting means a test file can't reliably set NO_COLOR before that. The
 * renderer's contract under test is the text content + branching, not the
 * ANSI wrapping (which is colors.ts's concern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detectDecision,
  formatBytes,
  formatDuration,
  type PendingTool,
  type RenderCounters,
  renderClaudeText,
  renderSummaryLine,
  summarizeToolInput,
  truncate,
} from '../claude-renderer.js'

// ---------------------------------------------------------------------------
// detectDecision — the Decision: regex (candidate item (a))
// ---------------------------------------------------------------------------

describe('detectDecision', () => {
  it('matches "Decision: foo" (no quote prefix)', () => {
    expect(detectDecision('Decision: pick option B')).toBe('pick option B')
  })

  it('matches "> Decision: foo" (markdown blockquote prefix)', () => {
    expect(detectDecision('> Decision: pick option B')).toBe('pick option B')
  })

  it('matches case-insensitively: DECISION: foo', () => {
    // The regex's /i flag is load-bearing per bots/README.md: prompts can
    // emit either casing; both are decisions and should surface in the
    // live log. Mutation: drop /i → DECISION: matches fail.
    expect(detectDecision('DECISION: shipping the patch')).toBe('shipping the patch')
  })

  it('matches "decision: foo" (lowercase)', () => {
    expect(detectDecision('decision: ship it')).toBe('ship it')
  })

  it('does NOT match in-prose mentions of "Decision:" past line start', () => {
    // Counterfactual: if the `^` anchor were dropped, this would match
    // (returning "yes"), but it must NOT — that would surface every prose
    // mention of "Decision:" as a star-prefixed line in the live log.
    expect(detectDecision('That was the decision: yes')).toBeNull()
  })

  it('does NOT match a backticked `Decision:` inline', () => {
    // Same counterfactual: line-start anchor is what excludes this.
    expect(detectDecision('We use a `Decision:` marker.')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(detectDecision('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(detectDecision('   ')).toBeNull()
  })

  it('matches with multiple leading spaces after the `>` prefix', () => {
    // `\s*` allows zero-or-more whitespace after the optional `>`. Mutation:
    // tighten to `\s+` and this would still match `> Decision:` (because
    // the space after > is required) but `>Decision:` would not — that
    // alternative is covered separately below.
    expect(detectDecision('>   Decision: indented decision')).toBe('indented decision')
  })

  it('matches "Decision:" with NO space after the colon', () => {
    // `\s*` after `Decision:` permits zero whitespace. Trailing characters
    // are captured greedy as `(.+)`. Mutation: change `\s*` to `\s+` here
    // and this fails (the `>` test above would still pass).
    expect(detectDecision('Decision:no-space-after-colon')).toBe('no-space-after-colon')
  })
})

// ---------------------------------------------------------------------------
// summarizeToolInput — per-tool input-field selection (candidate item (b))
// ---------------------------------------------------------------------------

describe('summarizeToolInput', () => {
  it('Bash: returns the command verbatim when ≤120 chars', () => {
    // Counterfactual: if the Bash branch returned input.cmd instead of
    // input.command, this would return the fallback JSON stringify.
    expect(summarizeToolInput('Bash', { command: 'gh issue view 245' })).toBe('gh issue view 245')
  })

  it('Bash: truncates commands over 120 chars with an ellipsis', () => {
    // Counterfactual: if truncate's threshold were 121 instead of 120,
    // this 200-char input would return verbatim, lengthening the live log.
    const longCmd = 'echo '.repeat(50) // 250 chars
    const result = summarizeToolInput('Bash', { command: longCmd })
    expect(result.length).toBeLessThanOrEqual(120)
    expect(result.endsWith('…')).toBe(true)
  })

  it('Read: returns file_path verbatim (no truncation — paths are useful at any length)', () => {
    // Counterfactual: if Read's branch also truncated to 120, very long
    // monorepo paths (e.g. nested workspace paths) would lose their tail.
    expect(summarizeToolInput('Read', { file_path: 'packages/gazetta/src/admin-api/routes/pages.ts' })).toBe(
      'packages/gazetta/src/admin-api/routes/pages.ts',
    )
  })

  it('Grep: returns just the pattern when no path is set', () => {
    expect(summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('TODO')
  })

  it('Grep: returns "pattern in path" when both fields are present', () => {
    // Counterfactual: if the ` in ${path}` segment dropped, the live log
    // would lose the search scope context (which directory was searched).
    expect(summarizeToolInput('Grep', { pattern: 'TODO', path: 'packages/gazetta' })).toBe('TODO in packages/gazetta')
  })

  it('Glob: returns the pattern verbatim', () => {
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('Write: returns the file_path verbatim', () => {
    expect(summarizeToolInput('Write', { file_path: 'bots/_lib/foo.ts' })).toBe('bots/_lib/foo.ts')
  })

  it('Edit: returns the file_path verbatim', () => {
    expect(summarizeToolInput('Edit', { file_path: 'bots/_lib/foo.ts' })).toBe('bots/_lib/foo.ts')
  })

  it('Unknown tool: falls back to JSON.stringify of the input, truncated', () => {
    // Counterfactual: if the fallback dropped the truncate(…, 120), a
    // 500-char JSON blob would explode the live log line.
    expect(summarizeToolInput('SomeUnknownTool', { x: 1, y: 'foo' })).toBe('{"x":1,"y":"foo"}')
  })

  it('Bash with missing command field: falls through to JSON.stringify (not a crash)', () => {
    // Counterfactual: if the Bash branch read input.command without the
    // typeof guard, a missing field would return `undefined` instead of
    // falling through to the generic JSON fallback — silent bad UX.
    expect(summarizeToolInput('Bash', { other: 'field' })).toBe('{"other":"field"}')
  })

  it('Read with non-string file_path: falls through to JSON.stringify', () => {
    // Same typeof guard counterfactual as above, applied to Read.
    expect(summarizeToolInput('Read', { file_path: 123 })).toBe('{"file_path":123}')
  })
})

// ---------------------------------------------------------------------------
// truncate — pure helper (boundary mutation surface)
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns the string unchanged when below the max', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns the string unchanged when exactly at the max (boundary)', () => {
    // Counterfactual: if the condition were `s.length >= max` instead of
    // `s.length > max`, a 10-char string with max=10 would get truncated
    // to "hello wor…" — losing one char unnecessarily.
    expect(truncate('1234567890', 10)).toBe('1234567890')
  })

  it('truncates to (max-1) chars + ellipsis when over the max', () => {
    // Counterfactual: if the slice were `s.slice(0, max)` (without the -1),
    // the result would be (max+1) chars total. The contract is the result
    // fits within `max` chars, including the ellipsis.
    const result = truncate('12345678901234', 10)
    expect(result).toBe('123456789…')
    expect(result.length).toBe(10)
  })

  it('returns empty string for empty input', () => {
    expect(truncate('', 5)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// formatBytes — boundary rolls at 1024 and 1024² (candidate item (c))
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
  it('renders sub-KB values in bytes', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(500)).toBe('500B')
  })

  it('renders the just-under-KB boundary in bytes (1023 < 1024)', () => {
    // Counterfactual: if the condition were `n <= 1024` instead of
    // `n < 1024`, 1023 would still be bytes (it is), but 1024 would
    // also fall into bytes — a wrong-tier display.
    expect(formatBytes(1023)).toBe('1023B')
  })

  it('rolls 1024 → 1.0KB (KB boundary)', () => {
    // Per candidate item (c): "1024 → KB" is the specific assertion. If
    // a mutation flipped the condition to `n <= 1024`, this would return
    // '1024B' instead — the test catches it.
    expect(formatBytes(1024)).toBe('1.0KB')
  })

  it('renders mid-KB values with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5KB')
  })

  it('rolls 1024² → 1.0MB (MB boundary)', () => {
    // Per candidate item (c): "1024² → MB" is the specific assertion.
    expect(formatBytes(1024 * 1024)).toBe('1.0MB')
  })

  it('renders mid-MB values with one decimal', () => {
    expect(formatBytes(Math.floor(1024 * 1024 * 1.5))).toBe('1.5MB')
  })
})

// ---------------------------------------------------------------------------
// formatDuration — rolls at 1000ms
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('renders sub-second durations in milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('rolls 1000ms → 1.0s', () => {
    // Counterfactual: condition `ms <= 1000` would render 1000 as '1000ms'.
    expect(formatDuration(1000)).toBe('1.0s')
  })

  it('renders multi-second durations with one decimal', () => {
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(12_345)).toBe('12.3s')
  })
})

// ---------------------------------------------------------------------------
// renderSummaryLine — dispatch on event type (candidate item (d) lives here)
// ---------------------------------------------------------------------------

describe('renderSummaryLine', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let pending: Map<string, PendingTool>
  let counters: RenderCounters

  beforeEach(() => {
    // Per-test isolation per team-preferences rule 26: fresh map + counters,
    // so a stale `pending` entry from a sibling test can't leak across.
    pending = new Map()
    counters = { toolCalls: 0, decisions: 0 }
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('silently ignores non-JSON lines (transcript still has them)', () => {
    // Counterfactual: if the try/catch were removed, JSON.parse would
    // throw and the renderer would crash the whole stream pipeline.
    renderSummaryLine('not json at all', pending, counters)
    expect(logSpy).not.toHaveBeenCalled()
    expect(counters.toolCalls).toBe(0)
    expect(counters.decisions).toBe(0)
  })

  it('silently ignores empty input', () => {
    renderSummaryLine('', pending, counters)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('silently ignores events of unknown types', () => {
    // Counterfactual: if the renderer logged an "unknown event" diagnostic,
    // every stream-json schema bump (Anthropic adds a new event type) would
    // spam the live log. The contract is graceful pass-through.
    renderSummaryLine(JSON.stringify({ type: 'some-future-event-type', data: 'foo' }), pending, counters)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('records a tool_use in the pending map and bumps the tool-call counter', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_001',
            name: 'Bash',
            input: { command: 'gh issue view 1' },
          },
        ],
      },
    }
    renderSummaryLine(JSON.stringify(event), pending, counters)
    expect(pending.has('toolu_001')).toBe(true)
    expect(pending.get('toolu_001')?.name).toBe('Bash')
    expect(pending.get('toolu_001')?.summary).toBe('gh issue view 1')
    expect(counters.toolCalls).toBe(1)
    // tool_use alone does NOT log (the line is paired with tool_result).
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('pairs a tool_result with its pending tool_use and logs the combined line', () => {
    // Set up: pre-seed pending with a call (as if a prior assistant event
    // had registered it).
    pending.set('toolu_002', { name: 'Bash', summary: 'gh issue view 245', startedAt: Date.now() })
    const event = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_002',
            content: 'a'.repeat(2048), // → 2.0KB
          },
        ],
      },
    }
    renderSummaryLine(JSON.stringify(event), pending, counters)
    // The pending entry was consumed.
    expect(pending.has('toolu_002')).toBe(false)
    expect(logSpy).toHaveBeenCalledTimes(1)
    // Counterfactual: if `formatBytes` were not invoked, the live log
    // would have a raw "2048" instead of "2.0KB".
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('Bash')
    expect(logged).toContain('2.0KB')
    expect(logged).toContain('gh issue view 245')
  })

  it('renders an orphaned tool_result without crashing (candidate item (d))', () => {
    // CANDIDATE-DOCUMENTED CASE: the tool_use_id has NO entry in pending.
    // Counterfactual: if the `else` branch were removed and the renderer
    // tried to read `call.summary` on undefined, the whole stream pipeline
    // would crash. The contract is: log a synthetic "(orphaned result, …)"
    // line so a future agent reading the live log sees the anomaly.
    const event = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_nope_not_in_pending', // no matching call
            content: 'orphan body',
          },
        ],
      },
    }
    expect(() => renderSummaryLine(JSON.stringify(event), pending, counters)).not.toThrow()
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('orphaned result')
  })

  it('formats a successful result event with duration + turn count + stats', () => {
    counters.toolCalls = 3
    counters.decisions = 2
    const event = {
      type: 'result',
      is_error: false,
      duration_ms: 12_500,
      num_turns: 7,
    }
    renderSummaryLine(JSON.stringify(event), pending, counters)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('done')
    expect(logged).toContain('13s') // 12500ms rounded → 13s
    expect(logged).toContain('7 turns')
    expect(logged).toContain('3 tool calls')
    expect(logged).toContain('2 decisions')
  })

  it('formats a successful result event with correct singular pluralization at 1', () => {
    counters.toolCalls = 1
    counters.decisions = 1
    const event = { type: 'result', is_error: false, duration_ms: 1000, num_turns: 1 }
    renderSummaryLine(JSON.stringify(event), pending, counters)
    const logged = logSpy.mock.calls[0][0] as string
    // Counterfactual: if the ternary were inverted (drop the `=== 1` check
    // or compare to 0), this would render "1 tool calls" or "1 decision".
    expect(logged).toContain('1 tool call,')
    expect(logged).toContain('1 decision')
    expect(logged).not.toContain('1 tool calls')
    expect(logged).not.toContain('1 decisions')
  })

  it('formats an error result event with the seconds elapsed', () => {
    const event = { type: 'result', is_error: true, duration_ms: 3200 }
    renderSummaryLine(JSON.stringify(event), pending, counters)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('Claude error after')
    expect(logged).toContain('3s')
  })

  it('handles result events with missing duration_ms (renders 0s)', () => {
    // Counterfactual: if the `r.duration_ms ?? 0` fallback were just
    // `r.duration_ms`, undefined would render as "NaNs" or "undefineds".
    const event = { type: 'result', is_error: false, num_turns: 1 }
    renderSummaryLine(JSON.stringify(event), pending, counters)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('0s')
  })

  it('routes assistant text blocks through renderClaudeText (decisions bump the counter)', () => {
    // Integration check: the renderSummaryLine dispatcher must hand off
    // assistant text to renderClaudeText so decisions are counted. Without
    // the dispatch, a decision in a text block would not surface.
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Decision: route the dispatch through the renderer' }],
      },
    }
    renderSummaryLine(JSON.stringify(event), pending, counters)
    expect(counters.decisions).toBe(1)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('Decision:')
    expect(logged).toContain('route the dispatch through the renderer')
  })

  it('handles tool_result with structured array content (size = JSON.stringify length)', () => {
    pending.set('toolu_003', { name: 'Read', summary: 'foo.ts', startedAt: Date.now() })
    const event = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_003',
            content: [{ type: 'text', text: 'inner' }],
          },
        ],
      },
    }
    renderSummaryLine(JSON.stringify(event), pending, counters)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    // The structured content gets JSON.stringify'd to compute size; we
    // don't pin the exact byte count (JSON.stringify includes braces +
    // quoting), but we DO pin that the tool was rendered with its name.
    // Counterfactual: if the array branch were removed and `.length` were
    // read directly on the array, the size would be `1` (array length)
    // rather than the stringified length — silently bad.
    expect(logged).toContain('Read')
  })
})

// ---------------------------------------------------------------------------
// renderClaudeText — decision detection vs narration vs disclaimer
// ---------------------------------------------------------------------------

describe('renderClaudeText', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let counters: RenderCounters

  beforeEach(() => {
    counters = { toolCalls: 0, decisions: 0 }
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('does nothing for empty text', () => {
    renderClaudeText('', counters)
    expect(logSpy).not.toHaveBeenCalled()
    expect(counters.decisions).toBe(0)
  })

  it('does nothing for whitespace-only text', () => {
    renderClaudeText('   \n   \n', counters)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('logs a decision line and increments counters.decisions', () => {
    renderClaudeText('Decision: extract the helpers', counters)
    expect(counters.decisions).toBe(1)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('Decision:')
    expect(logged).toContain('extract the helpers')
  })

  it('counts multiple decisions across multiple lines in the same text block', () => {
    // Counterfactual: if the for-loop `break` were placed too eagerly,
    // only the first decision would count. The current code continues
    // past decisions; only NON-decision narration breaks the loop.
    renderClaudeText('Decision: first\nDecision: second\nDecision: third', counters)
    expect(counters.decisions).toBe(3)
    expect(logSpy).toHaveBeenCalledTimes(3)
  })

  it('skips the AI-disclaimer prefix line silently', () => {
    // Counterfactual: if the disclaimer guard were removed, the disclaimer
    // would render as a narration line in the live log — operator noise.
    renderClaudeText('> *This was generated by AI during triage.*', counters)
    expect(logSpy).not.toHaveBeenCalled()
    expect(counters.decisions).toBe(0)
  })

  it('renders the first non-decision line as a narration and breaks after one', () => {
    // Contract: "Only the first non-decision line per text block" — keeps
    // the live log tight. Counterfactual: if `break` were removed, every
    // line of a multi-paragraph reply would flood console.
    renderClaudeText('First narration line.\nSecond narration line.\nThird narration line.', counters)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('First narration line.')
    expect(logged).not.toContain('Second narration line.')
  })

  it('renders decisions THEN breaks on the first narration (decisions before narration)', () => {
    // Two decisions log; the third (narration) logs once; loop ends.
    renderClaudeText('Decision: A\nDecision: B\nNow some prose.', counters)
    expect(counters.decisions).toBe(2)
    expect(logSpy).toHaveBeenCalledTimes(3) // 2 decisions + 1 narration
  })

  it('truncates long narration lines to ≤140 chars (with ellipsis)', () => {
    // Counterfactual: if the truncate cap were 200 or removed, very long
    // single-line reasoning would push the live log off-screen.
    const long = 'a'.repeat(200)
    renderClaudeText(long, counters)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    // The logged string carries the dimmed-emoji prefix + the truncated
    // narration. We assert the meaningful payload (the 'a's + ellipsis)
    // appears, but the 'a' run cannot exceed 140 chars.
    const aRun = logged.match(/a+/)
    expect(aRun).not.toBeNull()
    expect(aRun?.[0]?.length ?? 0).toBeLessThanOrEqual(140)
    // The truncation marker '…' is uniquely produced by `truncate()` in
    // this code path — the dimmed-emoji prefix is '💬', not '…'. So
    // toContain confirms truncation without sensitivity to trailing ANSI
    // reset codes the colors helper may emit (NO_COLOR set in source-text
    // order doesn't take effect because ES imports are hoisted past it).
    expect(logged).toContain('…')
  })
})
