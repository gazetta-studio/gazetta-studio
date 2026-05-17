/**
 * review-on-comment — PR-comment-driven code review.
 *
 * Triggered by .github/workflows/review-on-comment.yml on `issue_comment`
 * events whose body matches `@claude review` or `@claude audit`. Reads the
 * grammar, fetches the PR diff, invokes the appropriate skill via
 * `claude -p` with `Skill` tool access, parses the structured output, and
 * posts the result as a PR comment with an outcome tag.
 *
 * This bot is reactive (one-shot per comment); no skip-list, no
 * lessons-learned, no cron. Sub-folder under bots/ to inherit:
 *   - the workspace tsx + vitest infrastructure
 *   - bots/_lib/ helpers (claude.ts, github.ts, review-comment-grammar.ts,
 *     review-dispatch.ts)
 *   - the bots-wide outcome-tag + decision-log conventions
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { octokitFromEnv, repoFromEnv } from '../_lib/github.js'
import { parseCommentRequest, type CommentRequest } from '../_lib/review-comment-grammar.js'
import { extractLastAssistantText } from '../_lib/transcript.js'
import { printNotice, printWarning } from '../_lib/ui.js'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const TRANSCRIPT_DIR = resolve(HERE, '..', 'transcripts', 'review-on-comment')

interface CommentContext {
  prNumber: number
  commentId: number
  commentBody: string
  commentAuthor: string
  runId: string
}

/** Read the workflow env into a typed context. */
function readEnv(): CommentContext {
  const prNumber = Number(process.env.PR_NUMBER)
  const commentId = Number(process.env.COMMENT_ID)
  const commentBody = process.env.COMMENT_BODY ?? ''
  const commentAuthor = process.env.COMMENT_AUTHOR ?? 'unknown'
  const runId = process.env.GITHUB_RUN_ID ?? 'local'
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`PR_NUMBER env var missing or invalid: ${process.env.PR_NUMBER}`)
  }
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new Error(`COMMENT_ID env var missing or invalid: ${process.env.COMMENT_ID}`)
  }
  return { prNumber, commentId, commentBody, commentAuthor, runId }
}

/**
 * Build the prompt that invokes the right skill for this request.
 *
 * The prompt is short — most of the heavy lifting lives in the skill
 * SKILL.md files. The wrapper hands Claude the request shape, the
 * concrete PR number to diff against, and the response-format
 * requirement; the skill body owns the review.
 */
function buildPrompt(req: CommentRequest, ctx: CommentContext): string {
  const header = `# Review request from PR #${ctx.prNumber}

Comment author: @${ctx.commentAuthor}
Trigger comment: ${JSON.stringify(ctx.commentBody.trim().slice(0, 200))}

You are running headlessly in a GitHub Actions workflow. Your output
will be posted as a PR comment on PR #${ctx.prNumber}. Use the Skill
tool to invoke the right code-review skill; let it handle reading
the diff (via \`gh pr diff ${ctx.prNumber}\`), applying the angle
lens(es), and emitting the structured findings fence.

Decision-log: emit \`> Decision: ...\` lines for load-bearing choices
(which skill you invoked, why; how you handled the findings).
`

  switch (req.kind) {
    case 'review-all':
      return `${header}

## Task

Invoke the \`review-orchestrator\` skill to perform a full Phase 2
evaluation of PR #${ctx.prNumber}. Pass \`--pr ${ctx.prNumber}\` as
the argument so the orchestrator gathers the diff via
\`gh pr diff ${ctx.prNumber}\`.

After the skill returns, render its output as:

1. A short markdown summary at the top (counts + brief headline per
   severity).
2. The original \`findings\` JSONL fence verbatim (for downstream
   tooling that wants the structured form).
3. Inline-comment hints for CRITICAL findings — list them as a
   separate "## Critical findings" section.

End with this outcome tag (REQUIRED — the maintainer's query
mechanism depends on it):

<!-- review-on-comment: run=${ctx.runId} -->
`

    case 'review-angles':
      return `${header}

## Task

The user requested ${req.angles.length} specific angle(s): ${req.angles.join(', ')}.

For each angle, invoke that angle's skill directly via the Skill tool
(e.g. \`Skill: review-security\`). Pass \`--pr ${ctx.prNumber}\` as
the argument so each angle gathers the diff itself.

After all angles return, aggregate per the design-code-review.md
"Aggregation" rules:
1. Group findings by \`(file, line, category)\`
2. Drop confidence < 80
3. Sort by severity rank (CRITICAL → IMPORTANT → NIT), then file path

Render as a single markdown summary + the aggregated \`findings\`
JSONL fence verbatim. Include a "## Critical findings" section if
any CRITICAL findings exist.

End with this outcome tag (REQUIRED):

<!-- review-on-comment: run=${ctx.runId} -->
`

    case 'audit':
      return `${header}

## Task

Invoke the \`audit-area\` skill via the Skill tool with the path
argument \`${req.path}\`. The skill walks the area and emits a
\`candidates\` JSONL fence (NOT findings — candidates have a
different schema).

After the skill returns, render its output as:

1. A short markdown summary (count of candidates + headline).
2. The original \`candidates\` JSONL fence verbatim.
3. A "## Top candidate" section highlighting the #1 candidate's
   \`suggested_action\` (so the maintainer sees the recommendation
   at a glance).

End with this outcome tag (REQUIRED):

<!-- review-on-comment: run=${ctx.runId} -->
`

    case 'unrecognized':
      return `${header}

## Task

The trigger comment was not recognized. Reason: ${req.reason}

Post a short, friendly explanatory comment to PR #${ctx.prNumber} via
\`gh pr comment ${ctx.prNumber} -b "..."\` explaining:
- What trigger phrases ARE recognized:
  - \`@claude review\` — full review
  - \`@claude review <angle>\` — single angle (security, architecture, tests, types, comments, diff)
  - \`@claude audit <path>\` — discovery on a path
- The specific reason this comment didn't match.

End the body with this outcome tag (REQUIRED):

<!-- review-on-comment: run=${ctx.runId} -->

Exit cleanly after posting.
`
  }
}

/**
 * Post the orchestrator's stdout to the PR as a new comment.
 *
 * The orchestrator emits markdown + a fenced findings/candidates block
 * + the outcome tag. We post it verbatim (modulo a prefix that anchors
 * it as bot output).
 */
async function postReviewComment(body: string, ctx: CommentContext): Promise<void> {
  const octokit = octokitFromEnv()
  const repo = repoFromEnv()
  const prefixed = `> *This was generated by AI in response to [@${ctx.commentAuthor}'s comment](#issuecomment-${ctx.commentId}).*\n\n${body}`
  await octokit.issues.createComment({
    ...repo,
    issue_number: ctx.prNumber,
    body: prefixed,
  })
  printNotice(`Posted review comment to PR #${ctx.prNumber}`)
}

async function main(): Promise<void> {
  const ctx = readEnv()
  const req = parseCommentRequest(ctx.commentBody)

  printNotice(`PR #${ctx.prNumber} comment ${ctx.commentId} from @${ctx.commentAuthor}: ${req.kind}`)

  const transcriptPath = resolve(TRANSCRIPT_DIR, `${ctx.runId}.jsonl`)
  const prompt = buildPrompt(req, ctx)

  const result = await runClaude({
    prompt,
    transcriptPath,
    // Skill is the canonical surface for invoking skills (ADR-0012).
    // Bash for `gh pr diff` and any skill-invoked git operations.
    // Read for reading source files when angles need to inspect.
    // No Write/Edit — wrapper only reads + invokes skills.
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Skill'],
  })

  if (!result.success) {
    printWarning(`Claude exited ${result.exitCode}; not posting a partial review.`)
    process.exit(1)
  }

  // Claude's final assistant text is the review output. Read it from
  // the transcript (the canonical source) and post it to the PR.
  const body = extractLastAssistantText(result.transcriptPath)
  await postReviewComment(body || '(empty response from review skill)', ctx)
}

main().catch(err => {
  printWarning(`review-on-comment failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
