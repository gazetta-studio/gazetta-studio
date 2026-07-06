/**
 * ui.ts helpers tests (coverage-shape).
 *
 * Pins the behavior each `print*` function's docblock promises:
 *
 *   - printBanner emits the name, purpose, and every input / output line;
 *     tagline is included when supplied and omitted (no `undefined`) when
 *     not
 *   - printCandidateHeader emits `[index/total]`, the label, and elapsed
 *     time as `Ns`; meta lines appear only when supplied
 *   - printTranscriptPath emits the path in a single line
 *   - printRunSummary emits the verb + `processed/total` + elapsed; the
 *     `skipped` line only appears when `skipped > 0`; notes appear only
 *     when supplied
 *   - printNotice / printWarning emit the message with their glyph
 *   - printCandidateList early-returns on empty input, uses singular
 *     for 1 and plural for N, and emits each candidate's ref + label
 *     (plus meta when supplied)
 *
 * These helpers call `console.log` directly (no injected LogFn — that
 * shape is `claude-render.ts`'s). Tests capture stdout via
 * `vi.spyOn(console, 'log')`, matching the repo-wide pattern used in
 * `resolver.test.ts`, `site-loader.test.ts`, and
 * `cross-foundation-capability-gap-chain.test.ts`.
 *
 * Assertions use `.toContain` on unstyled substrings — the emoji /
 * box-drawing / plain-text content sits INSIDE the ANSI wrapping, so
 * substring checks are colour-mode-agnostic (see `colors.ts` — colour
 * is enabled by default outside `NO_COLOR` / `TERM=dumb`, and the
 * module reads env once at import time so tests can't reliably force
 * either mode).
 *
 * Per `testing-plan.md` "Shape per sub-system", this is unit-first
 * coverage of the bot infra formatting layer (same tier as
 * `claude-render.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  printBanner,
  printCandidateHeader,
  printCandidateList,
  printNotice,
  printRunSummary,
  printTranscriptPath,
  printWarning,
} from '../ui.js'

// ---------------------------------------------------------------------------
// Capture harness
// ---------------------------------------------------------------------------

let captured: string[]
let spy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  captured = []
  spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    // Reproduce console.log's " " join between argument slots; treat
    // `console.log()` (no args) as a blank entry so we can count lines.
    captured.push(args.map(a => (a == null ? '' : String(a))).join(' '))
  })
})

afterEach(() => {
  spy.mockRestore()
})

/** Everything printed, joined for substring queries. */
function output(): string {
  return captured.join('\n')
}

// ---------------------------------------------------------------------------
// printBanner
// ---------------------------------------------------------------------------

describe('printBanner', () => {
  it('emits the name, purpose, and every input / output line', () => {
    // > Decision: counterfactuals — if `opts.purpose` weren't printed at all,
    // > the purpose substring fails; if the input/output loops didn't
    // > iterate (or only rendered the first entry), the second-item
    // > substrings ('inputs2' / 'outputs2') fail.
    printBanner({
      name: 'my-bot',
      purpose: 'audit stuff',
      inputs: ['inputs1', 'inputs2'],
      outputs: ['outputs1', 'outputs2'],
    })
    const out = output()
    expect(out).toContain('my-bot')
    expect(out).toContain('audit stuff')
    expect(out).toContain('inputs1')
    expect(out).toContain('inputs2')
    expect(out).toContain('outputs1')
    expect(out).toContain('outputs2')
  })

  it('includes the tagline when provided', () => {
    printBanner({
      name: 'my-bot',
      tagline: 'producer bot · self-classifies',
      purpose: 'p',
      inputs: [],
      outputs: [],
    })
    expect(output()).toContain('producer bot · self-classifies')
  })

  it('omits any "undefined" residue when tagline is not provided', () => {
    // > Decision: counterfactual — if the ternary at line 34 were removed
    // > (`const name = \`${c.bold(opts.name)} · ${opts.tagline}\``), the
    // > banner would render "my-bot · undefined". Assert the string
    // > 'undefined' does NOT appear anywhere in output so that mutation is
    // > caught. `.not.toContain('undefined')` is meaningful because none of
    // > the other inputs contain that substring.
    printBanner({ name: 'my-bot', purpose: 'p', inputs: [], outputs: [] })
    expect(output()).not.toContain('undefined')
  })

  it('emits the input / output section headers', () => {
    // > Decision: counterfactual — if the '📥 Input' / '📤 Output' section
    // > labels were dropped, a reader can't scan which list is which. Assert
    // > both labels appear.
    printBanner({ name: 'n', purpose: 'p', inputs: ['a'], outputs: ['b'] })
    const out = output()
    expect(out).toContain('Input')
    expect(out).toContain('Output')
  })
})

// ---------------------------------------------------------------------------
// printCandidateHeader
// ---------------------------------------------------------------------------

describe('printCandidateHeader', () => {
  it('emits the [index/total] counter, the label, and the elapsed time', () => {
    // > Decision: counterfactuals — if the counter interpolation dropped
    // > `opts.total`, output would be `[1/]`; if the elapsed suffix `s` were
    // > dropped, `45` would appear without unit. The three substrings each
    // > defend against one of those mutations.
    printCandidateHeader({ index: 2, total: 7, label: 'my-cut', elapsedSec: 45 })
    const out = output()
    expect(out).toContain('[2/7]')
    expect(out).toContain('my-cut')
    expect(out).toContain('45s')
  })

  it('renders every meta line under the header when meta is provided', () => {
    // > Decision: counterfactual — if the `if (opts.meta?.length)` guard
    // > were inverted (dropped, or `!opts.meta?.length`), the meta lines
    // > would never render. Assert both meta strings appear.
    printCandidateHeader({
      index: 1,
      total: 1,
      label: 'x',
      elapsedSec: 0,
      meta: ['meta-first', 'meta-second'],
    })
    const out = output()
    expect(out).toContain('meta-first')
    expect(out).toContain('meta-second')
  })

  it('does not render any meta glyph when meta is omitted', () => {
    // > Decision: counterfactual — the meta list is prefixed with `└` (line
    // > 66). If the guard were removed and `opts.meta` were undefined, the
    // > for-loop would throw. Absent an exception, assert the `└` glyph
    // > does NOT appear so a mutation that emits a bare bullet on undefined
    // > meta is caught.
    printCandidateHeader({ index: 1, total: 1, label: 'x', elapsedSec: 0 })
    expect(output()).not.toContain('└')
  })
})

// ---------------------------------------------------------------------------
// printTranscriptPath
// ---------------------------------------------------------------------------

describe('printTranscriptPath', () => {
  it('emits the path in a single line', () => {
    // > Decision: counterfactuals — if the path were dropped from
    // > interpolation, the substring fails; if the function emitted zero or
    // > multiple lines instead of exactly one, the length assertion fails.
    printTranscriptPath('/tmp/transcripts/foo.jsonl')
    expect(output()).toContain('/tmp/transcripts/foo.jsonl')
    expect(captured).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// printRunSummary
// ---------------------------------------------------------------------------

describe('printRunSummary', () => {
  it('emits the verb, processed/total, and elapsed time', () => {
    printRunSummary({
      verb: 'Investigated',
      processed: 3,
      total: 5,
      skipped: 0,
      elapsedSec: 12,
    })
    const out = output()
    expect(out).toContain('Investigated')
    expect(out).toContain('3/5')
    expect(out).toContain('12s')
  })

  it('omits the "skipped" line when skipped === 0', () => {
    // > Decision: counterfactual — this is the load-bearing test for the
    // > `if (opts.skipped > 0)` guard at line 97. If the guard were
    // > dropped, output would include "0 skipped"; if the comparison were
    // > `>=` instead of `>`, same failure. Assert the word 'skipped' is
    // > absent for skipped=0. (No other field in this call renders that
    // > word, so the substring is a clean signal.)
    printRunSummary({
      verb: 'Investigated',
      processed: 3,
      total: 5,
      skipped: 0,
      elapsedSec: 12,
    })
    expect(output()).not.toContain('skipped')
  })

  it('emits the "skipped" line when skipped > 0', () => {
    // > Decision: counterfactual — inverse of the previous test. If the
    // > guard were inverted (`skipped <= 0` or `skipped < 0`), skipped=2
    // > would render nothing. Assert both the count and the word appear.
    printRunSummary({
      verb: 'Investigated',
      processed: 3,
      total: 5,
      skipped: 2,
      elapsedSec: 12,
    })
    const out = output()
    expect(out).toContain('2')
    expect(out).toContain('skipped')
  })

  it('emits every note line when notes are provided', () => {
    // > Decision: counterfactual — if the notes for-loop only rendered the
    // > first entry, note-two would be missing.
    printRunSummary({
      verb: 'Triaged',
      processed: 1,
      total: 1,
      skipped: 0,
      elapsedSec: 1,
      notes: ['note-one', 'note-two'],
    })
    const out = output()
    expect(out).toContain('note-one')
    expect(out).toContain('note-two')
  })
})

// ---------------------------------------------------------------------------
// printNotice / printWarning
// ---------------------------------------------------------------------------

describe('printNotice', () => {
  it('emits the message with the ℹ glyph', () => {
    // > Decision: counterfactual — the ℹ glyph is what distinguishes a
    // > notice from a warning at a glance in the workflow log; if the
    // > glyph were dropped or swapped, the assertion fails.
    printNotice('no candidates found, exiting')
    const out = output()
    expect(out).toContain('no candidates found, exiting')
    expect(out).toContain('ℹ')
  })
})

describe('printWarning', () => {
  it('emits the message with the ⚠ glyph', () => {
    // > Decision: counterfactual — same as printNotice: the glyph is the
    // > semantic signal; a mutation that swaps ⚠ for ℹ (or drops it)
    // > breaks the "one candidate failed but run continues" contract.
    printWarning('one candidate failed')
    const out = output()
    expect(out).toContain('one candidate failed')
    expect(out).toContain('⚠')
  })
})

// ---------------------------------------------------------------------------
// printCandidateList
// ---------------------------------------------------------------------------

describe('printCandidateList', () => {
  it('emits nothing when the candidate array is empty', () => {
    // > Decision: counterfactual — this is the load-bearing test for the
    // > `if (opts.candidates.length === 0) return` early return at line
    // > 132. Without it, the header line would render as "0 candidates".
    // > Assert captured has zero entries so any output at all fails.
    printCandidateList({ noun: 'candidate', candidates: [] })
    expect(captured).toHaveLength(0)
  })

  it('uses the singular noun form for a single candidate', () => {
    // > Decision: counterfactual — the singular/plural ternary at line 133
    // > is `length === 1 ? noun : \`${noun}s\``. If the check were `> 0`,
    // > singular would never fire; if `>= 1`, singular would apply for 2+.
    // > Assert output contains '1 candidate ' (with trailing space to
    // > distinguish from the substring 'candidate' in 'candidates') AND
    // > does NOT contain 'candidates'.
    printCandidateList({
      noun: 'candidate',
      candidates: [{ ref: '#101', label: 'lone' }],
    })
    const out = output()
    expect(out).toContain('1 candidate ')
    expect(out).not.toContain('candidates')
  })

  it('uses the plural form for two or more candidates', () => {
    // > Decision: counterfactual — inverse of the previous test. If the
    // > ternary always returned the singular, "2 candidates" fails.
    printCandidateList({
      noun: 'candidate',
      candidates: [
        { ref: '#101', label: 'a' },
        { ref: '#102', label: 'b' },
      ],
    })
    expect(output()).toContain('2 candidates')
  })

  it('renders each candidate ref, label, and optional meta', () => {
    // > Decision: counterfactuals — if the candidate for-loop were bounded
    // > wrong (e.g. `i < candidates.length - 1`), the third candidate
    // > would drop; if the meta suffix were dropped, meta-c would be
    // > missing. Absent-meta counterpart is covered by the next test.
    printCandidateList({
      noun: 'issue',
      candidates: [
        { ref: '#1', label: 'a-label' },
        { ref: '#2', label: 'b-label', meta: 'meta-b' },
        { ref: '#3', label: 'c-label', meta: 'meta-c' },
      ],
    })
    const out = output()
    expect(out).toContain('#1')
    expect(out).toContain('a-label')
    expect(out).toContain('#2')
    expect(out).toContain('b-label')
    expect(out).toContain('meta-b')
    expect(out).toContain('#3')
    expect(out).toContain('c-label')
    expect(out).toContain('meta-c')
  })

  it('does not leak "undefined" into the line when meta is absent', () => {
    // > Decision: counterfactual — the meta guard at line 136 is
    // > `candidate.meta ? ... : ''`. If the guard were removed and meta
    // > were interpolated bare, the line would read `... a-label undefined`.
    // > Assert 'undefined' does not appear.
    printCandidateList({
      noun: 'issue',
      candidates: [{ ref: '#1', label: 'a-label' }],
    })
    expect(output()).not.toContain('undefined')
  })
})
