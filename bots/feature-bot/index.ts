/**
 * feature-bot — implements `enhancement + ready-for-agent` cut sub-issues.
 *
 * Per design-feature-bot.md, feature-bot is a producer bot that reads
 * cut sub-issues from GitHub (per Q1: cuts live in tracking issues +
 * sub-issues, not in `.claude/rules/design-*-implementation.md` tables)
 * and ships one PR per cut via a generator-critic loop (per Q6: Agent A
 * implements, Agent B reviews, three-tier escalation
 * APPROVE / NEEDS_INPUT / NEEDS_HUMAN).
 *
 * # Cut 1 status (this file)
 *
 * Cut 1 ships the **skeleton + supporting infrastructure** as a
 * standalone PR per the design's Cut sequence:
 *
 *   - bots/feature-bot/index.ts        ← this file (cron banner +
 *                                        candidate query + DRY_RUN exit
 *                                        + manual-mode plumbing)
 *   - bots/feature-bot/skip-list.ts    ← extended SkipReason union
 *                                        (8 values per Q7)
 *   - bots/feature-bot/reviewer-log.ts ← peer of fix-bot's, paths rebound
 *   - bots/feature-bot/skip-list.json  ← empty initial state
 *   - bots/feature-bot/prompts/        ← per-cut.md + reviewer.md
 *                                        placeholders (Cut 3 writes the
 *                                        bodies)
 *   - bots/feature-bot/lessons-learned.md ← empty placeholder
 *
 * Cut 1 deliberately **does not invoke Claude**. The skeleton prints the
 * banner, queries candidates, logs them, and exits. The parser ships in
 * Cut 2; the generator-critic loop ships in Cut 3; the workflow ships in
 * Cut 4. Each cut is independently rollback-able per team-preferences
 * rule 17.
 *
 * # Two trigger modes (same shape as fix-bot)
 *
 *   1. Cron (default): scans for `enhancement + ready-for-agent` issues
 *      that lack `ready-for-human` / `wontfix` / `needs-info`. Per Q1,
 *      this is the canonical input — disjoint from fix-bot's
 *      `bug + ready-for-agent` queue, disjoint from discovery-prep-bot's
 *      `enhancement` (lacking `ready-for-agent`) queue.
 *
 *   2. Manual via `ISSUE_NUMBER` env: attempt a single specific sub-issue,
 *      regardless of label state. Useful for re-attempts after prompt
 *      iteration once Cut 3 ships.
 *
 * # Run locally
 *
 *   # Cron mode — scan all enhancement + ready-for-agent sub-issues:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run feature-bot -w @gazetta/bots
 *
 *   # Manual one-issue mode:
 *   ISSUE_NUMBER=501 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run feature-bot -w @gazetta/bots
 *
 *   # Skeleton-validating mode (no GitHub access needed in cron mode if
 *   # GH_TOKEN is set):
 *   DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run feature-bot -w @gazetta/bots
 *
 * # Run in CI
 *
 * .github/workflows/feature-bot.yml — lands in Cut 4.
 */
import { findIssuesByLabels, octokitFromEnv, repoFromEnv } from '../_lib/github.js'
import { printBanner, printCandidateList, printNotice, printWarning } from '../_lib/ui.js'

const DRY_RUN = process.env.DRY_RUN === '1'

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  // Manual one-issue mode short-circuits the cron scan. Validate the env
  // var shape early so a typo'd ISSUE_NUMBER fails loud rather than
  // cascading through the Cut 2/3 parser as a malformed candidate.
  const issueNumberStr = process.env.ISSUE_NUMBER
  if (issueNumberStr) {
    if (!/^\d+$/.test(issueNumberStr)) {
      console.error(`ISSUE_NUMBER='${issueNumberStr}' must be a positive integer`)
      process.exit(2)
    }
    printBanner({
      name: 'feature-bot',
      tagline: 'implementer (Cut 1 skeleton)',
      purpose: 'Manual one-cut mode — placeholder until Cut 3 wires the generator-critic loop.',
      inputs: [`Sub-issue #${issueNumberStr} (manual override)`],
      outputs: ['skeleton — parser and loop ship in Cuts 2/3'],
    })
    printNotice(
      `Manual mode targets sub-issue #${issueNumberStr}. Skeleton stops here; Cut 3 wires the generator-critic loop.`,
    )
    return
  }

  printBanner({
    name: 'feature-bot',
    tagline: 'implementer (Cut 1 skeleton)',
    purpose: 'Implement `enhancement + ready-for-agent` cut sub-issues with TDD-first commit ordering.',
    inputs: [
      'Open issues with `enhancement` AND `ready-for-agent`',
      'AND no `ready-for-human` / `wontfix` / `needs-info`',
    ],
    outputs: [
      'skeleton — parser and loop ship in Cuts 2/3',
      'Cut 2 adds: cut-sub-issue parser (**Feature** + **Depends on**)',
      'Cut 3 adds: generator-critic loop with 3-tier escalation',
      'Cut 4 adds: GitHub Actions workflow + cron',
    ],
  })

  printNotice(`Scanning ${repo.owner}/${repo.repo} for enhancement+ready-for-agent cut sub-issues`)

  // Q1 lock: feature-bot's input is `enhancement + ready-for-agent` with
  // standard exclusions. Disjoint from fix-bot (which requires `bug`) and
  // from discovery-prep-bot (which excludes `ready-for-agent`). Tracking
  // issues (no `ready-for-agent`) are invisible to this query.
  const allCandidates = await findIssuesByLabels(octokit, repo, {
    requireAll: ['enhancement', 'ready-for-agent'],
    excludeAny: ['ready-for-human', 'wontfix', 'needs-info'],
  })

  if (allCandidates.length === 0) {
    printNotice('No feature-bot candidates found. Inbox zero — nothing to do. ✨')
    return
  }

  // Q4 lock: oldest-first sort, deterministic tiebreaker by issue number.
  // No priority label in v1 — matches fix-bot's pattern.
  const candidates = [...allCandidates].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt)
    return a.number - b.number
  })

  printCandidateList({
    noun: 'cut sub-issue',
    candidates: candidates.map(c => ({ ref: `#${c.number}`, label: c.title })),
  })

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before any work (${candidates.length} would be considered).`)
    return
  }

  // Cut 1 stops here. Future cuts:
  //   Cut 2 — parse `**Feature**:` + `**Depends on**:` from each body;
  //           validate referenced numbers; loud-fail on bad refs
  //   Cut 3 — generator-critic loop (Agent A + Agent B + three-tier
  //           escalation per Q6)
  //   Cut 4 — .github/workflows/feature-bot.yml (cron + cache + concurrency)
  printWarning('skeleton — parser and loop ship in Cuts 2/3')
  printNotice(`Cut 1 ships skeleton only; ${candidates.length} candidates listed above are not processed yet.`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
