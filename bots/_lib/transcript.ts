/**
 * Transcript helpers — read assistant text blocks out of the JSONL
 * stream `runClaude` writes.
 *
 * Two consumers (dead-code-watcher, fix-bot) plus reviewer-verdict
 * parsing make this the 3rd-caller threshold per team-preferences
 * rule 19 ("extract shared code when 3+ callers exist").
 */
import { readFileSync } from 'node:fs'

/**
 * Walk every assistant `text` block in the transcript, return as a
 * list in chronological order. Empty list when the file can't be read
 * or contains no assistant text.
 */
export function collectAssistantTexts(transcriptPath: string): string[] {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    const texts: string[] = []
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              texts.push(block.text)
            }
          }
        }
      } catch {
        // ignore malformed line
      }
    }
    return texts
  } catch {
    return []
  }
}

/**
 * Return the LAST assistant text block. Used when we want raw final
 * output (e.g. parsing reviewer verdict lines).
 */
export function extractLastAssistantText(transcriptPath: string): string {
  const all = collectAssistantTexts(transcriptPath)
  return all.at(-1) ?? ''
}

/**
 * Extract the structured `SUMMARY:` block from an agent's transcript.
 *
 * Agent A (per-finding / per-issue prompt) is asked to end with:
 *
 *   SUMMARY:
 *   <2-4 sentences describing the change>
 *
 *   Runtime exercise:
 *   <per-bullet, per-path input + actual output>
 *
 * We walk every assistant `text` block (newest first) and return all
 * content after the LAST `SUMMARY:` marker — including subsections
 * like `Runtime exercise:` that are separated from the lead prose by
 * blank lines. Falls back to the final assistant message when no
 * marker is present — keeps the bot working against older transcripts
 * and against responses that miss the convention (which still happens
 * occasionally in practice).
 *
 * History: the dead-code-watcher v2 run on 2026-05-14 (PR #376) showed
 * why the marker matters — Agent A's last text block was protocol
 * narration ("Committed locally..."), so the substantive summary in
 * an earlier block was lost. The feature-bot run on 2026-05-30
 * (PR #456) showed why we need the WHOLE block, not just the lead
 * paragraph: Agent A's `Runtime exercise:` subsection — the proof
 * that the cut works on every path — was truncated because the
 * regex stopped at the first blank line.
 */
export function extractSummary(transcriptPath: string): string {
  const all = collectAssistantTexts(transcriptPath)
  for (let i = all.length - 1; i >= 0; i--) {
    const text = all[i]
    const idx = text.search(/SUMMARY:\s*\n?/i)
    if (idx === -1) continue
    const afterMarker = text
      .slice(idx)
      .replace(/^SUMMARY:\s*\n?/i, '')
      .trim()
    if (afterMarker) return afterMarker
  }
  return all.at(-1) ?? ''
}
