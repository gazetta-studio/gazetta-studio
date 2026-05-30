import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectAssistantTexts, extractLastAssistantText, extractSummary } from '../transcript.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'transcript-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeJsonl(events: unknown[]): string {
  const path = resolve(dir, 'transcript.jsonl')
  writeFileSync(path, `${events.map(e => JSON.stringify(e)).join('\n')}\n`)
  return path
}

function assistant(text: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}

describe('collectAssistantTexts', () => {
  it('returns texts in chronological order', () => {
    const path = writeJsonl([assistant('first'), assistant('second'), assistant('third')])
    expect(collectAssistantTexts(path)).toEqual(['first', 'second', 'third'])
  })

  it('skips non-assistant events and non-text blocks', () => {
    const path = writeJsonl([
      { type: 'user', message: { content: [{ type: 'text', text: 'user-msg' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      assistant('only-real-text'),
    ])
    expect(collectAssistantTexts(path)).toEqual(['only-real-text'])
  })

  it('returns [] for non-existent file', () => {
    expect(collectAssistantTexts(resolve(dir, 'missing.jsonl'))).toEqual([])
  })

  it('ignores malformed JSONL lines', () => {
    const path = resolve(dir, 'mixed.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify(assistant('ok'))}\nnot-json-at-all\n${JSON.stringify(assistant('also-ok'))}\n`,
    )
    expect(collectAssistantTexts(path)).toEqual(['ok', 'also-ok'])
  })
})

describe('extractLastAssistantText', () => {
  it('returns the final text block', () => {
    const path = writeJsonl([assistant('first'), assistant('last')])
    expect(extractLastAssistantText(path)).toBe('last')
  })

  it('returns empty string when no assistant text exists', () => {
    const path = writeJsonl([{ type: 'user', message: { content: [{ type: 'text', text: 'u' }] } }])
    expect(extractLastAssistantText(path)).toBe('')
  })
})

describe('extractSummary', () => {
  it('extracts content after the SUMMARY: marker', () => {
    const path = writeJsonl([assistant('Working on it.\n\nSUMMARY:\nRemoved the unused barrel export. Tests pass.')])
    expect(extractSummary(path)).toBe('Removed the unused barrel export. Tests pass.')
  })

  it('picks the SUMMARY block from the latest message when present in multiple', () => {
    const path = writeJsonl([
      assistant('SUMMARY:\nFirst attempt summary.'),
      assistant('SUMMARY:\nFinal attempt summary.'),
    ])
    expect(extractSummary(path)).toBe('Final attempt summary.')
  })

  it('falls back to the last assistant text when no SUMMARY: marker is present', () => {
    // Reproduces PR #376: the agent ended with protocol verbiage,
    // not a SUMMARY: block — we still want SOMETHING for the PR body.
    const path = writeJsonl([
      assistant('substantive summary in an earlier message'),
      assistant('Committed locally on dead-code/foo. Not pushing per generator-critic instructions.'),
    ])
    expect(extractSummary(path)).toBe(
      'Committed locally on dead-code/foo. Not pushing per generator-critic instructions.',
    )
  })

  it('captures the full block including subsections separated by blank lines', () => {
    // Per PR #456 fix: the SUMMARY block carries subsections (e.g.
    // `Runtime exercise:`) separated from the lead prose by blank lines.
    // The whole block must reach the PR body so the maintainer sees
    // the per-path proof, not just the prose intro.
    const path = writeJsonl([
      assistant('SUMMARY:\nRemoved foo.ts; no callers.\n\nRuntime exercise:\nBullet 1, happy path: input=X, output=Y'),
    ])
    expect(extractSummary(path)).toBe(
      'Removed foo.ts; no callers.\n\nRuntime exercise:\nBullet 1, happy path: input=X, output=Y',
    )
  })

  it('extracts SUMMARY when it appears mid-message followed by other content', () => {
    // The SUMMARY marker can sit inside a longer assistant message.
    // We capture from the marker to the end of THAT message — trailing
    // narration after the marker is intentional content (e.g., subsections).
    const path = writeJsonl([
      assistant('Working on it.\n\nSUMMARY:\nThe cut shipped clean.\n\nRuntime exercise:\nAll 4 paths passed.'),
    ])
    expect(extractSummary(path)).toBe('The cut shipped clean.\n\nRuntime exercise:\nAll 4 paths passed.')
  })

  it('ignores in-prose SUMMARY: mentions and uses the conventional line-start marker', () => {
    // Reproduces the bug surfaced by feature-bot attempt 3 of cut #445:
    // Agent A's narration referenced the marker in a backtick-quoted
    // phrase ("the proper `SUMMARY:` block...") BEFORE emitting the
    // real one at line-start. The first-match regex grabbed the
    // in-prose mention and returned garbage. Line-anchored (^...\m)
    // + take-last-match fixes both axes.
    const path = writeJsonl([
      assistant(
        'I will now emit the proper `SUMMARY:` block.\n\n```\nSUMMARY:\nThe cut shipped clean.\n\nRuntime exercise:\nAll paths verified.\n```',
      ),
    ])
    expect(extractSummary(path)).toBe('The cut shipped clean.\n\nRuntime exercise:\nAll paths verified.\n```')
  })

  it('returns empty string when no assistant text exists', () => {
    expect(extractSummary(writeJsonl([]))).toBe('')
  })
})
