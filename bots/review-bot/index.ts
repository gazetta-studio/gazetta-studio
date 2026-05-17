/**
 * review-bot — autonomous code-improvement producer.
 *
 * Status: Phase 0 implemented (P4 Cut 18). Phases 1-5 still stubbed;
 * Cut 19 wires them in a follow-up cut.
 *
 * Pipeline (per design-code-review.md "Review-bot (autonomous)"):
 *
 *   Phase 0  — Pick an area                                       [Cut 18 — IMPLEMENTED]
 *              TS: score top 5 areas by recency + bot-touched + skip-list
 *              LLM: pick one with one-line context per candidate
 *
 *   Phase 1  — Discovery                                          [Cut 19 — pending]
 *              Skill: audit-area <picked-area>
 *              Output: ranked candidate improvements
 *
 *   Phase 2  — Pick top candidate                                 [Cut 19 — pending]
 *              TS: sort by (severity, confidence); skip skip-list matches
 *
 *   Phase 3  — Make the change (Agent A)                          [Cut 19 — pending]
 *              Prompt: prompts/agent-a.md with injected candidate +
 *              lessons-learned.md
 *              TDD-first ordering (failing test commit before fix)
 *
 *   Phase 4  — Review the diff (Agent B)                          [Cut 19 — pending]
 *              Skill: review-orchestrator on git diff main...improve/<id>
 *              Output: aggregated findings via JSONL fence
 *
 *   Phase 5  — Verdict + action                                   [Cut 19 — pending]
 *              CRITICAL → REJECT (retry) or NEEDS_HUMAN (log + skip)
 *              IMPORTANT only → REJECT with Note (retry)
 *              NIT only / empty → APPROVE → push branch, open PR
 *
 * Generator-critic pattern matches dead-code-watcher + fix-bot
 * (per ADR-0011 + bots/README.md). Same memory model: skip-list
 * committed to repo; reviewer-log cached via actions/cache;
 * lessons-learned.md committed and rewritten by the monthly
 * compactor.
 *
 * Single-instance invariant: workflow concurrency group 'review-bot'
 * with cancel-in-progress: false (per ADR-0011).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { printNotice, printWarning } from '../_lib/ui.js'
import { type AreaCandidate, scoreAreas } from './area-scorer.js'
import { collectBotPRsByArea, collectGitTouches, parsePickerOutput } from './phase0-collect.js'
import { readSkipList } from './skip-list.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKIPLIST_PATH = resolve(HERE, 'skip-list.json')
const LESSONS_PATH = resolve(HERE, 'lessons-learned.md')
const PICKER_PROMPT_PATH = resolve(HERE, 'prompts', 'area-picker.md')
const TRANSCRIPT_DIR = resolve(HERE, '..', 'transcripts', 'review-bot')

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1'
  const runId = process.env.GITHUB_RUN_ID ?? 'local'

  printNotice('review-bot — Phase 0 (area pick) implemented; Phases 1-5 pending (Cut 19).')

  const skipList = readSkipList(SKIPLIST_PATH)
  printNotice(`Skip-list: ${skipList.entries.length} entries, ${skipList.rules.length} rules.`)

  // Phase 0 — collect signals + score areas.
  printNotice('Phase 0: collecting signals...')
  const touches = await collectGitTouches({ sinceDays: 30 })
  const botPRs = await collectBotPRsByArea({ sinceDays: 180 })
  const candidates = scoreAreas(touches, botPRs, skipList, { topN: 5, maxDepth: 3 })

  printNotice(`Phase 0: scored ${candidates.length} candidate area(s).`)
  for (const c of candidates) {
    const colddays = Number.isFinite(c.daysSinceBotTouched) ? `${Math.round(c.daysSinceBotTouched)}d` : '∞'
    printNotice(`  ${c.area} — score=${c.score.toFixed(1)}, files=${c.touchedFiles}, bot-touched=${colddays} ago`)
  }

  if (candidates.length === 0) {
    printNotice('Phase 0: no eligible areas — exiting cleanly.')
    process.exit(0)
  }

  if (dryRun) {
    printNotice('DRY_RUN=1: skipping LLM picker; Phase 0 scoring only.')
    process.exit(0)
  }

  // Phase 0 — invoke the LLM picker.
  printNotice('Phase 0: invoking area-picker...')
  const pickerResult = await runPicker(candidates, runId)
  if (!pickerResult.area) {
    printWarning(`Phase 0: picker returned no area: ${pickerResult.reasoning}`)
    process.exit(0)
  }
  printNotice(`Phase 0: picked area ${pickerResult.area}`)

  // STUB: Phase 1 audit-area invocation is not yet implemented (Cut 19).
  // STUB: Phase 2-5 generator-critic loop is not yet implemented (Cut 19).
  printWarning('Phase 1 (audit-area) and Phases 2-5 (Agent A → Agent B → verdict → PR) not yet implemented.')
  printWarning(`Stopping after Phase 0 with picked area: ${pickerResult.area}`)
  printWarning('Cut 19 wires the remaining phases.')

  process.exit(0)
}

async function runPicker(candidates: readonly AreaCandidate[], runId: string): Promise<{ area: string | null; reasoning: string }> {
  const pickerPromptTemplate = readFileSync(PICKER_PROMPT_PATH, 'utf-8')
  const lessons = readFileSync(LESSONS_PATH, 'utf-8')

  const candidatesBlock = candidates
    .map((c) => {
      const colddays = Number.isFinite(c.daysSinceBotTouched) ? `${Math.round(c.daysSinceBotTouched)}d` : 'never'
      return `- ${c.area} | touchedFiles=${c.touchedFiles} | bot-touched=${colddays} | score=${c.score.toFixed(1)}`
    })
    .join('\n')

  const prompt = `${pickerPromptTemplate}

# Inputs

CANDIDATES:
${candidatesBlock}

LESSONS_LEARNED:
${lessons}

RUN_ID: ${runId}
`

  const transcriptPath = resolve(TRANSCRIPT_DIR, `picker-${runId}.jsonl`)
  const result = await runClaude({
    prompt,
    transcriptPath,
    // Picker only needs to read the prompt + emit the PICK line; no
    // tool calls. We give Bash + Read for defensive measure but the
    // picker prompt instructs the LLM not to use them.
    allowedTools: ['Bash', 'Read'],
  })

  if (!result.success) {
    return { area: null, reasoning: `picker Claude exited ${result.exitCode}` }
  }

  // The picker's final assistant text contains the PICK line.
  const { extractLastAssistantText } = await import('../_lib/transcript.js')
  const text = extractLastAssistantText(transcriptPath)
  return parsePickerOutput(text)
}

main().catch((err) => {
  printWarning(`review-bot failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
