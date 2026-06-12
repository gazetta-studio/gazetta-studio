/**
 * Stream-json renderer tests (coverage-shape).
 *
 * Pins the behavior promised by the docblocks in `claude-render.ts`:
 *
 *   - Tool call + tool_result pairing produces one line with duration + size
 *     when the pending map carries the matching tool_use_id.
 *   - Orphaned tool_result renders "(orphaned result, <size>)".
 *   - `Decision:` text gets the ★ marker and increments counters.decisions.
 *   - Non-decision Claude text folds to first line + truncates at 140 chars.
 *   - `result` event with `is_error: true` renders ❌; success renders ✅
 *     with counts.
 *
 * The rendering functions take a `log: LogFn` parameter so tests capture
 * output into an array instead of stdout. Assertions use `.toContain` so
 * ANSI color codes (enabled by default outside `TERM=dumb`) don't pollute
 * the expected strings.
 *
 * Per testing-plan.md `Shape per sub-system`, this is unit-first pure-
 * function coverage of the bot infra rendering pipeline.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  formatBytes,
  formatDuration,
  type PendingTool,
  type RenderCounters,
  renderClaudeText,
  renderSummaryLine,
  summarizeToolInput,
  truncate,
} from '../claude-render.js'

function makeCounters(): RenderCounters {
  return { toolCalls: 0, decisions: 0 }
}

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns a string exactly at the max unchanged', () => {
    // Boundary: `s.length > max` is strictly greater-than; ===max passes through.
    expect(truncate('exactly10c', 10)).toBe('exactly10c')
  })

  it('truncates strings longer than max to max-1 chars + ellipsis', () => {
    // > Decision: counterfactual — if the slice were `slice(0, max)` (forgot the
    // > -1), output would be 11 chars total instead of 10; or if the ellipsis
    // > were dropped, the trailing "…" would be missing. Both are caught.
    const result = truncate('1234567890ab', 10)
    expect(result).toBe('123456789…')
    expect(result).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
  it('renders values below 1024 as B with no decimal', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(500)).toBe('500B')
    expect(formatBytes(1023)).toBe('1023B')
  })

  it('renders the 1024 boundary as 1.0KB (base-1024, not base-1000)', () => {
    // > Decision: counterfactual — if the divisor were 1000 (base-1000 SI),
    // > formatBytes(1024) would be '1.0KB' under both correct and mutated code
    // > (1024/1000 = 1.024 → '1.0'). So we ALSO assert on a value far enough
    // > from the boundary that the SI mutation diverges from binary —
    // > formatBytes(5 * 1024 * 1024) below catches that mutation.
    expect(formatBytes(1024)).toBe('1.0KB')
  })

  it('renders mid-range KB values to one decimal', () => {
    expect(formatBytes(5 * 1024)).toBe('5.0KB')
  })

  it('renders MB values to one decimal (5MB diverges between base-1024 and base-1000)', () => {
    // > Decision: counterfactual — under correct base-1024 math,
    // > 5*1024*1024 / 1024 / 1024 = 5.0. Under a base-1000 mutation,
    // > 5*1024*1024 / 1000 / 1000 = 5.24 → '5.2MB'. The expected '5.0MB'
    // > fails under that mutation. This is the test that defends against
    // > the SI/binary unit swap that smaller values silently survive.
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0MB')
  })

  it('renders the 1MB boundary correctly', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0MB')
  })
})

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('renders sub-second values as ms', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('renders 1000ms as 1.0s (boundary)', () => {
    expect(formatDuration(1000)).toBe('1.0s')
  })

  it('renders multi-second values to one decimal', () => {
    // > Decision: counterfactual — if the threshold were `ms <= 1000` instead
    // > of `< 1000`, formatDuration(1000) would render as '1000ms' instead
    // > of '1.0s'; the previous test catches that. This test additionally
    // > catches a mutation where the divisor went away (e.g. `ms.toFixed(1)`
    // > instead of `(ms/1000).toFixed(1)`) — 1234.toFixed(1) is '1234.0',
    // > nowhere near '1.2'.
    expect(formatDuration(1234)).toBe('1.2s')
  })
})

// ---------------------------------------------------------------------------
// summarizeToolInput
// ---------------------------------------------------------------------------

describe('summarizeToolInput', () => {
  it('extracts the command from a Bash tool input', () => {
    expect(summarizeToolInput('Bash', { command: 'ls -la' })).toBe('ls -la')
  })

  it('truncates long Bash commands at 120 chars', () => {
    // > Decision: counterfactual — without truncation, a 200-char command
    // > would render in full; we assert length<=120 so a `truncate` removal
    // > or the wrong limit (e.g. 200) is caught.
    const long = 'echo ' + 'x'.repeat(300)
    const summary = summarizeToolInput('Bash', { command: long })
    expect(summary.length).toBeLessThanOrEqual(120)
    expect(summary).toMatch(/…$/)
  })

  it('extracts the file_path from a Read tool input', () => {
    expect(summarizeToolInput('Read', { file_path: '/repo/foo.ts' })).toBe('/repo/foo.ts')
  })

  it('extracts the pattern from a Grep tool input without path', () => {
    expect(summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('TODO')
  })

  it('includes the path suffix when Grep has both pattern and path', () => {
    // > Decision: counterfactual — if the ` in ${path}` concatenation were
    // > dropped, output would just be 'TODO'. The expected 'TODO in src/'
    // > catches that.
    expect(summarizeToolInput('Grep', { pattern: 'TODO', path: 'src/' })).toBe('TODO in src/')
  })

  it('extracts the pattern from a Glob tool input', () => {
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('extracts the file_path from Write and Edit tool inputs', () => {
    expect(summarizeToolInput('Write', { file_path: '/out.txt' })).toBe('/out.txt')
    expect(summarizeToolInput('Edit', { file_path: '/src/foo.ts' })).toBe('/src/foo.ts')
  })

  it('falls back to truncated JSON for unrecognised tool names', () => {
    // > Decision: counterfactual — if the fallback returned the literal name
    // > or an empty string, the JSON content wouldn't appear. The expected
    // > substring check catches that.
    const summary = summarizeToolInput('UnknownTool', { foo: 'bar', n: 42 })
    expect(summary).toContain('"foo":"bar"')
    expect(summary).toContain('"n":42')
  })

  it('falls back to JSON when Bash is missing a command field', () => {
    // > Decision: the Bash branch guards on `typeof input.command === 'string'`.
    // > If the guard were removed, calling .replace or similar on undefined
    // > would throw. We confirm the fallback fires by checking JSON shape.
    const summary = summarizeToolInput('Bash', { wrongKey: 'oops' })
    expect(summary).toContain('"wrongKey":"oops"')
  })
})

// ---------------------------------------------------------------------------
// renderSummaryLine — tool_use → pending entry
// ---------------------------------------------------------------------------

describe('renderSummaryLine: tool_use event', () => {
  it('stashes the call in pending and increments toolCalls without logging', () => {
    // > Decision: counterfactual — tool_use does NOT log; logging is
    // > deferred to the matching tool_result. If a mutant emitted a log
    // > on tool_use, the captured array would be non-empty. The toolCalls
    // > counter MUST increment though — that drives the final summary
    // > stats. Removing the increment would fail the .toolCalls check.
    const pending = new Map<string, PendingTool>()
    const counters = makeCounters()
    const captured: string[] = []
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    }
    renderSummaryLine(JSON.stringify(event), pending, counters, line => captured.push(line))

    expect(captured).toEqual([])
    expect(counters.toolCalls).toBe(1)
    expect(pending.has('toolu_1')).toBe(true)
    expect(pending.get('toolu_1')?.name).toBe('Bash')
    expect(pending.get('toolu_1')?.summary).toBe('ls')
  })
})

// ---------------------------------------------------------------------------
// renderSummaryLine — tool_result pairing
// ---------------------------------------------------------------------------

describe('renderSummaryLine: tool_result event', () => {
  it('pairs with a prior tool_use, logging one line with name, duration, size, and summary', () => {
    // > Decision: counterfactual — multiple mutations are caught here at
    // > once: dropping the duration string ('1.2s' missing), dropping size
    // > ('17B' missing), dropping the summary ('ls -la' missing), or
    // > swapping name for id ('Bash' missing → 'toolu_1' appears). Each
    // > substring check defends against one of these.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const pending = new Map<string, PendingTool>()
      const counters = makeCounters()
      const captured: string[] = []

      // tool_use at T=0
      const useEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }],
        },
      }
      renderSummaryLine(JSON.stringify(useEvent), pending, counters, line => captured.push(line))

      // tool_result at T+1234ms, content is 18 chars ('total 4\ndrwxr-xr-x'.length)
      vi.advanceTimersByTime(1234)
      const resultEvent = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 4\ndrwxr-xr-x' }],
        },
      }
      renderSummaryLine(JSON.stringify(resultEvent), pending, counters, line => captured.push(line))

      expect(captured).toHaveLength(1)
      const out = captured[0]
      expect(out).toContain('Bash')
      expect(out).toContain('1.2s')
      expect(out).toContain('18B')
      expect(out).toContain('ls -la')
      // pending entry consumed
      expect(pending.has('toolu_1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders "(orphaned result, <size>)" when no matching tool_use is pending', () => {
    // > Decision: counterfactual — if the `else` branch were missing, the
    // > orphaned result would silently produce no output; the captured
    // > array would be empty. The "orphaned result" substring assertion
    // > fails under that mutation. We also confirm the size is formatted
    // > via formatBytes (not raw byte count) — 1024 chars must render as
    // > '1.0KB', not '1024' or '1024B'.
    const pending = new Map<string, PendingTool>()
    const counters = makeCounters()
    const captured: string[] = []
    const content = 'x'.repeat(1024)
    const event = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_unknown', content }],
      },
    }
    renderSummaryLine(JSON.stringify(event), pending, counters, line => captured.push(line))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('orphaned result')
    expect(captured[0]).toContain('1.0KB')
  })

  it('computes size from JSON.stringify when content is an array', () => {
    // > Decision: counterfactual — if size handling skipped the array
    // > branch and read .length on the array directly, content of [{...}]
    // > would report size 1 (array length), not the JSON byte size. The
    // > orphan path is the easiest entry point to assert this independent
    // > of timing.
    const pending = new Map<string, PendingTool>()
    const counters = makeCounters()
    const captured: string[] = []
    const event = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_unknown',
            content: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
    }
    renderSummaryLine(JSON.stringify(event), pending, counters, line => captured.push(line))

    expect(captured).toHaveLength(1)
    // JSON.stringify([{type:'text',text:'hello'}]) is 32 chars → '32B'
    expect(captured[0]).toContain('32B')
  })
})

// ---------------------------------------------------------------------------
// renderSummaryLine — result event
// ---------------------------------------------------------------------------

describe('renderSummaryLine: result event', () => {
  it('renders success with seconds, turns, and tool/decision counts', () => {
    // > Decision: counterfactual — the stats string interpolates
    // > counters.toolCalls and counters.decisions. Mutating those reads
    // > (e.g. always reading 0) would make the assertion against '3 tool
    // > calls, 2 decisions' fail. Plural agreement (`tool call` vs `tool
    // > calls`) is also load-bearing — covered in the separate plural test.
    const pending = new Map<string, PendingTool>()
    const counters: RenderCounters = { toolCalls: 3, decisions: 2 }
    const captured: string[] = []
    const event = {
      type: 'result',
      is_error: false,
      duration_ms: 5432,
      num_turns: 7,
    }
    renderSummaryLine(JSON.stringify(event), pending, counters, line => captured.push(line))

    expect(captured).toHaveLength(1)
    const out = captured[0]
    expect(out).toContain('done')
    expect(out).toContain('5s')
    expect(out).toContain('7 turns')
    expect(out).toContain('3 tool calls')
    expect(out).toContain('2 decisions')
    expect(out).not.toContain('Claude error')
  })

  it('uses singular noun forms when the counter is exactly 1', () => {
    // > Decision: counterfactual — the plural ternary is "?? '' : 's'".
    // > A mutation that always emits 's' would produce '1 tool calls,
    // > 1 decisions'; the singular assertion catches it.
    const pending = new Map<string, PendingTool>()
    const counters: RenderCounters = { toolCalls: 1, decisions: 1 }
    const captured: string[] = []
    const event = { type: 'result', is_error: false, duration_ms: 1000, num_turns: 1 }
    renderSummaryLine(JSON.stringify(event), pending, counters, line => captured.push(line))

    expect(captured[0]).toContain('1 tool call,')
    expect(captured[0]).toContain('1 decision')
    // Guard against the plural mutant: assert the trailing 's' is absent.
    expect(captured[0]).not.toContain('1 tool calls')
    expect(captured[0]).not.toContain('1 decisions')
  })

  it('renders error with seconds when is_error is true', () => {
    // > Decision: counterfactual — if the is_error branch were removed,
    // > success would render instead. The 'Claude error after' substring
    // > only appears on the error path. We also confirm the '✅ done'
    // > success marker is NOT present, ruling out a both-branches-render
    // > mutation.
    const pending = new Map<string, PendingTool>()
    const counters: RenderCounters = { toolCalls: 1, decisions: 0 }
    const captured: string[] = []
    const event = { type: 'result', is_error: true, duration_ms: 3500 }
    renderSummaryLine(JSON.stringify(event), pending, counters, line => captured.push(line))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('Claude error after')
    expect(captured[0]).toContain('4s') // Math.round(3500/1000) = 4
    expect(captured[0]).not.toContain('done')
  })

  it('defaults seconds to 0 when duration_ms is missing', () => {
    // > Decision: counterfactual — `r.duration_ms ? ... : 0`. If the
    // > zero-fallback were dropped, NaN or undefined would surface in
    // > the output ('NaNs' or 'undefineds'). The expected '0s' fails
    // > under that mutation.
    const pending = new Map<string, PendingTool>()
    const counters = makeCounters()
    const captured: string[] = []
    const event = { type: 'result', is_error: false }
    renderSummaryLine(JSON.stringify(event), pending, counters, line => captured.push(line))

    expect(captured[0]).toContain('0s')
    expect(captured[0]).toContain('0 turns')
  })
})

// ---------------------------------------------------------------------------
// renderSummaryLine — non-JSON line
// ---------------------------------------------------------------------------

describe('renderSummaryLine: non-JSON input', () => {
  it('silently skips lines that are not valid JSON', () => {
    // > Decision: counterfactual — without the try/catch, a malformed line
    // > would throw and bring down the rendering loop. The test asserts
    // > the call doesn't throw AND emits nothing.
    const pending = new Map<string, PendingTool>()
    const counters = makeCounters()
    const captured: string[] = []
    expect(() => renderSummaryLine('not valid json {', pending, counters, line => captured.push(line))).not.toThrow()
    expect(captured).toEqual([])
  })

  it('silently skips events of unknown type', () => {
    // > Decision: counterfactual — the chain of `if (event.type === ...)`
    // > checks ends without an else. A mutation that emits for unknown
    // > types would produce output we can detect. The empty array confirms
    // > the fall-through path.
    const pending = new Map<string, PendingTool>()
    const counters = makeCounters()
    const captured: string[] = []
    renderSummaryLine(JSON.stringify({ type: 'system' }), pending, counters, line => captured.push(line))
    expect(captured).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// renderClaudeText — decisions
// ---------------------------------------------------------------------------

describe('renderClaudeText: decision detection', () => {
  it('emits ★ marker and increments counters.decisions on "Decision:" text', () => {
    // > Decision: counterfactual — if the regex match were inverted or
    // > the increment dropped, the counter and ★ marker would both fail.
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('Decision: pick option B because of constraints', counters, line => captured.push(line))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('★')
    expect(captured[0]).toContain('Decision:')
    expect(captured[0]).toContain('pick option B because of constraints')
    expect(counters.decisions).toBe(1)
  })

  it('matches case-insensitively', () => {
    // > Decision: counterfactual — the regex flag is `/i`. A mutation
    // > dropping the flag would not match lowercase. The assertion fails
    // > under that mutation.
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('decision: lowercase still triggers', counters, line => captured.push(line))

    expect(counters.decisions).toBe(1)
    expect(captured[0]).toContain('lowercase still triggers')
  })

  it('matches a markdown-blockquote-prefixed decision', () => {
    // > Decision: counterfactual — the regex `^>?\s*Decision:` allows
    // > an optional leading `>`. Dropping the `?` would require it; the
    // > plain "Decision:" test above would still pass but only the
    // > blockquote variant proves the `>` form is supported.
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('> Decision: blockquote form', counters, line => captured.push(line))

    expect(counters.decisions).toBe(1)
    expect(captured[0]).toContain('blockquote form')
  })

  it('emits every Decision line in a multi-line block', () => {
    // > Decision: counterfactual — the loop uses `continue` after a
    // > decision (NOT break), so subsequent decision lines also fire.
    // > A mutation replacing continue with break would emit only the
    // > first decision; counters.decisions would be 1 instead of 2.
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('Decision: first\nDecision: second', counters, line => captured.push(line))

    expect(counters.decisions).toBe(2)
    expect(captured).toHaveLength(2)
    expect(captured[0]).toContain('first')
    expect(captured[1]).toContain('second')
  })
})

// ---------------------------------------------------------------------------
// renderClaudeText — non-decision narration
// ---------------------------------------------------------------------------

describe('renderClaudeText: non-decision narration', () => {
  it('emits 💬 with the first non-empty line, truncated to 140 chars', () => {
    // > Decision: counterfactual — the truncate limit is 140. A mutation
    // > to 200 (no truncation here) would let a 200-char line through
    // > unchanged. The endsWith('…') assertion fails under that mutation.
    const counters = makeCounters()
    const captured: string[] = []
    const long = 'x'.repeat(200)
    renderClaudeText(long, counters, line => captured.push(line))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('💬')
    expect(captured[0]).toContain('…')
    expect(counters.decisions).toBe(0)
  })

  it('emits ONLY the first non-decision line in a multi-line block', () => {
    // > Decision: counterfactual — the break is load-bearing for
    // > "keep live log tight". A mutation removing break would emit
    // > both narration lines; the captured.length === 1 assertion
    // > fails under that mutation.
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('first narration line\nsecond should not appear', counters, line => captured.push(line))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('first narration line')
    expect(captured[0]).not.toContain('second should not appear')
  })

  it('emits decisions AND the first non-decision line from a mixed block', () => {
    // > Decision: counterfactual — confirms the loop ordering: decision
    // > continues, narration breaks. Together this means a mixed block
    // > with [Decision, narration, Decision-again] emits the first
    // > Decision, the narration, then breaks (skipping the second
    // > Decision). Without ordering correctness, either we'd emit 3
    // > lines (no break) or 1 line (break on decision too).
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('Decision: A\nnarration\nDecision: B', counters, line => captured.push(line))

    expect(captured).toHaveLength(2)
    expect(captured[0]).toContain('Decision:')
    expect(captured[0]).toContain('A')
    expect(captured[1]).toContain('narration')
    expect(counters.decisions).toBe(1)
  })

  it('does nothing for empty or whitespace-only text', () => {
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('', counters, line => captured.push(line))
    renderClaudeText('   \n  \n\t', counters, line => captured.push(line))

    expect(captured).toEqual([])
    expect(counters.decisions).toBe(0)
  })

  it('skips the AI-disclaimer prefix line', () => {
    // > Decision: counterfactual — the disclaimer guard is a `startsWith`
    // > continue. A mutation removing it would emit the disclaimer as
    // > narration; the captured array would have one entry. The empty
    // > array assertion fails under that mutation.
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('> *This was generated by AI during triage.*', counters, line => captured.push(line))

    expect(captured).toEqual([])
  })

  it('after skipping the disclaimer, still renders the next non-decision line', () => {
    // > Decision: counterfactual — the disclaimer uses `continue`, not
    // > `break`. If it were `break`, the line after the disclaimer would
    // > never render. The expected 'real narration' substring fails
    // > under that mutation.
    const counters = makeCounters()
    const captured: string[] = []
    renderClaudeText('> *This was generated by AI during triage.*\nreal narration after disclaimer', counters, line =>
      captured.push(line),
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('real narration after disclaimer')
  })
})

// ---------------------------------------------------------------------------
// renderSummaryLine — assistant message with text content (decision routing)
// ---------------------------------------------------------------------------

describe('renderSummaryLine: assistant text block routes through renderClaudeText', () => {
  it('emits a ★ Decision line when the assistant message contains a Decision', () => {
    // > Decision: counterfactual — this confirms the wiring: an assistant
    // > event with a text block reaches renderClaudeText. If
    // > renderSummaryLine routed only tool_use blocks (dropping the text
    // > branch), the decisions counter would not increment.
    const pending = new Map<string, PendingTool>()
    const counters = makeCounters()
    const captured: string[] = []
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Decision: route the text through' }],
      },
    }
    renderSummaryLine(JSON.stringify(event), pending, counters, line => captured.push(line))

    expect(counters.decisions).toBe(1)
    expect(captured[0]).toContain('route the text through')
  })
})
