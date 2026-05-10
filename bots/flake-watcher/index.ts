/**
 * flake-watcher — daily CI flake detection.
 *
 * Strategy: rerun-then-passed. A workflow run with `run_attempt >= 2` means
 * an earlier attempt failed on the SAME SHA and someone hit "Re-run". This
 * is the strongest possible flake signal — same code, different outcome,
 * in the same workflow.
 *
 * Why not "two distinct same-SHA runs": GitHub Actions reruns are additional
 * attempts under the SAME run ID, not new runs. Looking for two distinct run
 * IDs with the same SHA returns cross-workflow noise (CI failure + Deploy
 * success on one commit isn't a flake).
 *
 * When a flake is found, hand the run to `claude -p` with the prompt in
 * `prompt.md`. Claude reads failed-attempt logs, searches existing open
 * issues for a match, and either comments on the existing issue (with
 * dedup against the run ID) or files a new one following the templates
 * established in #268.
 *
 * Run locally:
 *   DRY_RUN=1 LOOKBACK_HOURS=336 npm run flake-watcher -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/flake-watcher.yml (daily 12:00 UTC)
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFlakeCandidates, findWorkflowId, octokitFromEnv, repoFromEnv } from '../_lib/github.js'
import { runClaude } from '../_lib/claude.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompt.md')

const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS ?? '48')
const WORKFLOW_NAME = process.env.WORKFLOW_NAME ?? 'CI'
const DRY_RUN = process.env.DRY_RUN === '1'

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()
  const workflowId = await findWorkflowId(octokit, repo, WORKFLOW_NAME)

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000
  const sinceIso = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z')

  console.log(`Flake watcher: scanning ${WORKFLOW_NAME} (workflow id ${workflowId}) runs since ${sinceIso}`)

  const flakes = await findFlakeCandidates(octokit, repo, workflowId, sinceIso)

  if (flakes.length === 0) {
    console.log(`No flakes found in last ${LOOKBACK_HOURS}h. CI is healthy.`)
    return
  }

  console.log('Flake candidates:')
  for (const f of flakes) {
    console.log(`  run=${f.runId} sha=${f.headSha.slice(0, 8)} conclusion=${f.conclusion} attempt=${f.runAttempt}`)
  }

  if (DRY_RUN) {
    console.log(`DRY_RUN=1 — exiting before invoking Claude (${flakes.length} would be processed).`)
    return
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')

  for (const flake of flakes) {
    console.log(`\n=== Investigating run ${flake.runId} ===`)
    const prompt = `${promptTemplate}

RUN_ID=${flake.runId}
LOOKBACK_HOURS=${LOOKBACK_HOURS}`

    const result = runClaude({ prompt })
    if (!result.success) {
      // Don't let one failed investigation kill the whole job. Log and move on.
      console.log(`Warning: investigation of run ${flake.runId} exited ${result.exitCode}; continuing.`)
    }
  }

  console.log('\nFlake watcher complete.')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
