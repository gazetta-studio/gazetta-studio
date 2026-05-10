/**
 * Replay harness — re-investigate a past flake against the current prompt.
 *
 * Use case: an agent improving a bot's prompt wants to know whether the new
 * prompt produces better output than the old one. This module:
 *
 *   1. Pulls the transcripts artifact from a past workflow run via gh CLI
 *   2. Reads each transcript to recover (a) the original prompt, (b) the
 *      flake's RUN_ID input, (c) the original outcome
 *   3. Re-invokes the current prompt against each flake's RUN_ID, writing a
 *      new transcript next to the old one
 *   4. The agent reads both old + new transcripts and decides whether to
 *      keep the prompt change
 *
 * Storage layout:
 *   bots/transcripts/<bot-name>/<replay-source>/
 *     <past-run-id>-original.jsonl    (recovered from artifact)
 *     <past-run-id>-replay.jsonl      (current prompt against same flake)
 *
 * Usage:
 *   npx tsx bots/_lib/replay.ts <bot-name> <past-workflow-run-id>
 *   # e.g. npx tsx bots/_lib/replay.ts flake-watcher 25627966006
 *
 * The new transcripts are written to disk only — no issue/comment side
 * effects — because replay's purpose is evaluation, not action. The agent
 * is expected to read the new transcripts and decide if a real run with the
 * updated prompt is warranted.
 *
 * Note: actually preventing side effects in replayed Claude calls would
 * require the prompt to know about replay mode AND for Claude to honour it.
 * Today we rely on the agent running replay to inspect output before
 * shipping — replay isn't safe to run unattended.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from './claude.js'

interface PastInvestigation {
  runId: string
  originalTranscriptPath: string
}

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const BOTS_DIR = resolve(HERE, '..')
const REPO_ROOT = resolve(BOTS_DIR, '..')

async function main(): Promise<void> {
  const [, , botName, sourceRunId] = process.argv
  if (!botName || !sourceRunId) {
    console.error('Usage: tsx bots/_lib/replay.ts <bot-name> <past-workflow-run-id>')
    console.error('Example: tsx bots/_lib/replay.ts flake-watcher 25627966006')
    process.exit(2)
  }

  const botDir = resolve(BOTS_DIR, botName)
  const promptPath = resolve(botDir, 'prompt.md')
  if (!existsSync(promptPath)) {
    console.error(`No prompt.md found at ${promptPath} — is "${botName}" a real bot?`)
    process.exit(2)
  }

  // Stage transcripts under bots/transcripts/<bot>/replay-from-<source-run>/
  const stagingDir = resolve(BOTS_DIR, 'transcripts', botName, `replay-from-${sourceRunId}`)
  if (existsSync(stagingDir)) {
    console.log(`Cleaning previous staging at ${stagingDir}`)
    rmSync(stagingDir, { recursive: true, force: true })
  }
  mkdirSync(stagingDir, { recursive: true })

  // Step 1: download artifact from past run.
  console.log(`Downloading transcripts artifact from run ${sourceRunId}...`)
  const dl = spawnSync('gh', ['run', 'download', sourceRunId, '-n', `${botName}-transcripts`, '-D', stagingDir], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  if (dl.status !== 0) {
    console.error(`Failed to download artifact "${botName}-transcripts" from run ${sourceRunId}.`)
    console.error('Is the artifact still available (90-day default retention)? Was the bot named correctly?')
    process.exit(1)
  }

  // Step 2: enumerate the past investigations.
  const past = enumeratePastInvestigations(stagingDir)
  if (past.length === 0) {
    console.error(`No transcripts found in ${stagingDir} after download.`)
    process.exit(1)
  }
  console.log(`\nFound ${past.length} past investigation(s) to replay:`)
  for (const p of past) console.log(`  run=${p.runId}`)

  // Step 3: rename originals so replays land beside them.
  for (const p of past) {
    const originalRenamed = resolve(stagingDir, `${p.runId}-original.jsonl`)
    spawnSync('mv', [p.originalTranscriptPath, originalRenamed], { stdio: 'inherit' })
    p.originalTranscriptPath = originalRenamed
  }

  // Step 4: load the CURRENT prompt and replay.
  const promptTemplate = readFileSync(promptPath, 'utf-8')
  for (const p of past) {
    console.log(`\n=== Replaying run ${p.runId} against current prompt ===`)
    const replayPath = resolve(stagingDir, `${p.runId}-replay.jsonl`)
    const prompt = `${promptTemplate}

RUN_ID=${p.runId}
LOOKBACK_HOURS=replay`
    try {
      const result = await runClaude({ prompt, transcriptPath: replayPath })
      if (!result.success) {
        console.log(`Warning: replay of ${p.runId} exited ${result.exitCode}; continuing.`)
      }
    } catch (err) {
      console.log(`Warning: replay of ${p.runId} threw: ${err}; continuing.`)
    }
  }

  console.log(`\nReplay complete. Compare transcripts in: ${stagingDir}`)
  console.log('Per past investigation: <run-id>-original.jsonl vs <run-id>-replay.jsonl')
  console.log('\nWARNING: replays may have produced real side effects (issue comments, new')
  console.log('issues) if the current prompt instructs Claude to do so. Inspect before shipping.')
}

/**
 * Find every JSONL transcript downloaded from the source artifact and
 * recover its RUN_ID by parsing the original system event.
 *
 * Transcript filenames follow the pattern written by the bot:
 *   <iso-timestamp>-run-<run-id>.jsonl
 * but we also extract from the JSONL contents as a fallback.
 */
function enumeratePastInvestigations(stagingDir: string): PastInvestigation[] {
  const out: PastInvestigation[] = []
  for (const entry of readdirSync(stagingDir)) {
    if (!entry.endsWith('.jsonl')) continue
    const fullPath = resolve(stagingDir, entry)
    const runId = extractRunIdFromFilename(entry) ?? extractRunIdFromContents(fullPath)
    if (!runId) {
      console.warn(`Could not recover RUN_ID from ${entry}; skipping.`)
      continue
    }
    out.push({ runId, originalTranscriptPath: fullPath })
  }
  return out
}

function extractRunIdFromFilename(name: string): string | null {
  const m = name.match(/run-(\d+)\.jsonl$/)
  return m ? m[1] : null
}

function extractRunIdFromContents(path: string): string | null {
  // The user-prompt event includes the RUN_ID=N line we appended.
  const contents = readFileSync(path, 'utf-8')
  const m = contents.match(/RUN_ID=(\d+)/)
  return m ? m[1] : null
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
