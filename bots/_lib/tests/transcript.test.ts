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

  it('stops at the first blank-line boundary inside the SUMMARY block', () => {
    // Prevents trailing chatter ("Now I will...") from being included
    // when the agent keeps talking after the marker.
    const path = writeJsonl([
      assistant('SUMMARY:\nRemoved foo.ts; no callers.\n\nNow I will run the tests and commit.'),
    ])
    expect(extractSummary(path)).toBe('Removed foo.ts; no callers.')
  })

  it('returns empty string when no assistant text exists', () => {
    expect(extractSummary(writeJsonl([]))).toBe('')
  })
})
