/**
 * Pure helpers extracted from `compact.ts` main() so the load-bearing
 * branches — the pre-Claude gate, the prompt composition, and the
 * post-Claude prune ordering — can be unit-tested without spawning
 * Claude.
 *
 * Three concerns, one file (each is ~15-30 LOC; splitting further
 * would be over-engineering). Sibling pattern:
 * `bots/dead-code-watcher/post-claude.ts` extracts the post-Claude
 * branch only because that's the only load-bearing invariant its
 * compactor has (validation-before-prune ordering). Fix-bot's
 * compactor has three gates worth pinning; grouping them here keeps
 * the module role uniform ("things extracted from main() for
 * testability").
 */
import { pruneReviewerLog } from './reviewer-log.js'

/**
 * Result of `shouldRunCompaction`. Discriminated union so callers
 * can distinguish "below signal threshold" from "operator asked for
 * dry-run" — both block Claude but for different reasons, and the
 * observability contract of `compact.ts` prints different notices.
 */
export type CompactionGateOutcome =
  | { run: false; reason: 'below-threshold'; totalSignal: number; threshold: number }
  | { run: false; reason: 'dry-run' }
  | { run: true }

export interface CompactionGateInput {
  entryCount: number
  reviewerLogCount: number
  minEntriesForCompaction: number
  dryRun: boolean
}

/**
 * Decides whether to invoke Claude for a compaction run.
 *
 * Order is load-bearing: **threshold check first**, then dry-run. A
 * below-threshold run reports `below-threshold` (not `dry-run`) even
 * when `dryRun: true` — the operator's intent when DRY_RUN=1 is
 * "would I have invoked Claude?"; the answer below threshold is
 * "no, because there's not enough signal" regardless of the dry-run
 * flag. Reversing the check order would mask the below-threshold
 * signal on dry runs, breaking the observability contract.
 *
 * `totalSignal` is the SUM of skip-list entries + reviewer-log
 * entries — either signal alone can justify a rewrite (they capture
 * complementary patterns: skip-list = "don't try again"; reviewer-log
 * = "what to notice next time"). `min` uses `<` (strict less than)
 * so exactly-at-threshold proceeds.
 */
export function shouldRunCompaction(input: CompactionGateInput): CompactionGateOutcome {
  const totalSignal = input.entryCount + input.reviewerLogCount
  if (totalSignal < input.minEntriesForCompaction) {
    return {
      run: false,
      reason: 'below-threshold',
      totalSignal,
      threshold: input.minEntriesForCompaction,
    }
  }
  if (input.dryRun) {
    return { run: false, reason: 'dry-run' }
  }
  return { run: true }
}

export interface ComposePromptInput {
  promptTemplate: string
  skipListPath: string
  lessonsPath: string
  skipList: unknown
  reviewerLog: unknown
  lessonsContent: string
  runId: string
}

/**
 * Composes the prompt Claude receives from the compact.md template
 * + memory inputs. Pure string construction; extracted so the six
 * documented variables (per `prompts/compact.md`'s "Inputs" section)
 * can be pinned without spawning Claude.
 *
 * Any refactor that drops one of the six silently degrades Claude's
 * output quality — no error surface, just less signal in the
 * generated lessons. The tests pin all six so a future refactor
 * catches at CI time, not at monthly-cron time.
 *
 * JSON.stringify uses 2-space indentation deliberately — Claude
 * parses structure more reliably from indented JSON than from
 * single-line collapsed form.
 */
export function composePrompt(input: ComposePromptInput): string {
  return `${input.promptTemplate}

SKIP_LIST_PATH=${input.skipListPath}
LESSONS_PATH=${input.lessonsPath}
SKIP_LIST_JSON=${JSON.stringify(input.skipList, null, 2)}
REVIEWER_LOG_JSON=${JSON.stringify(input.reviewerLog, null, 2)}
PREVIOUS_LESSONS=
${input.lessonsContent}
RUN_ID=${input.runId}`
}

export interface PostClaudeInput {
  claudeSucceeded: boolean
  reviewerLogPath: string
  keepLast: number
}

export interface PostClaudeOutcome {
  /** Prune result when pruning ran. `null` when skipped because Claude failed. */
  prune: { dropped: number; kept: number } | null
}

/**
 * Post-Claude flow: prune the reviewer-log ONLY when Claude
 * succeeded. When Claude failed, preserve the full log so next
 * month's run can retry with the same input. Pruning on success
 * keeps the cached file bounded across many months.
 *
 * The load-bearing invariant: `claudeSucceeded: false` MUST NOT
 * prune. If the branch inverted, a failed run would evict its own
 * input — next month's retry would then be unable to reproduce the
 * failure and regenerate cleanly.
 *
 * Sibling pattern: `bots/dead-code-watcher/post-claude.ts`
 * `handlePostClaude`, minus the signal-count-drift validation gate
 * that fix-bot's compactor doesn't need (fix-bot's lessons don't
 * have a header/sub-tally count convention to drift against).
 */
export function handlePostClaude(input: PostClaudeInput): PostClaudeOutcome {
  if (!input.claudeSucceeded) {
    return { prune: null }
  }
  const prune = pruneReviewerLog(input.reviewerLogPath, input.keepLast)
  return { prune }
}
