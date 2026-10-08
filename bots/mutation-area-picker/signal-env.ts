/**
 * Real SignalEnv implementation — wraps git, gh, and filesystem
 * queries with the same interface tests inject mocks for.
 *
 * Each method runs ONE external command (git log, gh issue list,
 * file read). Caller batches across modules via Promise.all in
 * collectInclusionSignals.
 *
 * Performance note: at the design's "~50 candidate modules" envelope,
 * each module triggers ~5 external queries. 250 total per cron.
 * gh API has 5000 req/h limit; we're well under. git log is local.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeStepDurationMinutes } from './portfolio-runtime.js'
import type { SignalEnv } from './signals.js'

export interface SignalEnvOpts {
  /** Absolute path to the repo root. */
  repoRoot: string
  /** Test directory glob — defaults to packages/gazetta/tests/. */
  testDir?: string
  /** GitHub repo identity for gh commands ("owner/repo"). */
  ghRepo?: string
}

/**
 * Build a SignalEnv for production use. Each method shells out
 * to git or gh; failures return safe defaults (0 or []) so a
 * transient API outage doesn't crash the bot.
 */
export function createSignalEnv(opts: SignalEnvOpts): SignalEnv {
  const { repoRoot } = opts
  const testDir = opts.testDir ?? 'packages/gazetta/tests'

  return {
    async countCommitsTouching(modulePath, sinceDays) {
      const since = `${sinceDays}.days.ago`
      try {
        const output = execFileSync('git', ['log', `--since=${since}`, '--oneline', '--', modulePath], {
          cwd: repoRoot,
          encoding: 'utf-8',
        })
        return output.trim().split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    },

    async countAIPairedCommitsTouching(modulePath, sinceDays) {
      const since = `${sinceDays}.days.ago`
      try {
        // --grep filters commit messages; --all-match is irrelevant here
        // because we only have one --grep. Output is one line per commit
        // that touched the path AND has the Co-Authored-By line.
        const output = execFileSync(
          'git',
          ['log', `--since=${since}`, '--grep=Co-Authored-By: Claude', '--oneline', '--', modulePath],
          { cwd: repoRoot, encoding: 'utf-8' },
        )
        return output.trim().split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    },

    async countLines(absolutePath) {
      try {
        if (!existsSync(absolutePath)) return 0
        const content = readFileSync(absolutePath, 'utf-8')
        return content.split('\n').length
      } catch {
        return 0
      }
    },

    async findRelatedTestFiles(moduleBasename) {
      const dir = resolve(repoRoot, testDir)
      try {
        if (!existsSync(dir)) return []
        return readdirSync(dir)
          .filter(f => f.includes(moduleBasename) && (f.endsWith('.test.ts') || f.endsWith('.test.tsx')))
          .map(f => resolve(dir, f))
      } catch {
        return []
      }
    },

    async findFlakeIssuesMentioning(modulePath) {
      if (!opts.ghRepo) return 0
      try {
        // Open flake-labelled issues whose title or body mentions the
        // module's basename. We use the basename (not full path) because
        // issue titles rarely contain full paths.
        const basename = modulePath.split('/').pop() ?? modulePath
        const output = execFileSync(
          'gh',
          [
            'issue',
            'list',
            '--repo',
            opts.ghRepo,
            '--label',
            'flake',
            '--state',
            'open',
            '--search',
            basename,
            '--json',
            'number',
            '--limit',
            '50',
          ],
          { cwd: repoRoot, encoding: 'utf-8' },
        )
        return (JSON.parse(output) as unknown[]).length
      } catch {
        return 0
      }
    },

    async countRecentFixPRsTouching(modulePath, sinceDays) {
      if (!opts.ghRepo) return 0
      try {
        // We can't directly filter PRs by file path via `gh pr list`,
        // so we approximate: list merged fix: PRs in the window and
        // check their commits via git log on the path.
        // Cheaper: use `git log --grep="^fix:" --since=...` filtered to path.
        const since = `${sinceDays}.days.ago`
        const output = execFileSync('git', ['log', `--since=${since}`, '--grep=^fix:', '--oneline', '--', modulePath], {
          cwd: repoRoot,
          encoding: 'utf-8',
        })
        return output.trim().split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    },

    async fetchRecentStrykerRuntimes(workflowFile, stepName, limit) {
      if (!opts.ghRepo) return []
      try {
        // Step 1: find the N most-recent successful runs of the
        // nightly mutation workflow.
        const runsOutput = execFileSync(
          'gh',
          [
            'run',
            'list',
            '--repo',
            opts.ghRepo,
            '--workflow',
            workflowFile,
            '--status',
            'success',
            '--limit',
            String(limit),
            '--json',
            'databaseId',
          ],
          { cwd: repoRoot, encoding: 'utf-8' },
        )
        const runs = JSON.parse(runsOutput) as Array<{ databaseId: number }>
        if (runs.length === 0) return []

        // Step 2: for each run, pull the step metadata and find the
        // named step. Each call is one gh api hit; the limit is small
        // (5 by default) so we stay well under the 5000 req/h ceiling.
        const durations: number[] = []
        for (const run of runs) {
          try {
            const jobsOutput = execFileSync(
              'gh',
              ['api', `/repos/${opts.ghRepo}/actions/runs/${run.databaseId}/jobs`],
              { cwd: repoRoot, encoding: 'utf-8' },
            )
            const parsed = JSON.parse(jobsOutput) as {
              jobs: Array<{
                steps?: Array<{ name: string; started_at: string | null; completed_at: string | null }>
              }>
            }
            // Flatten steps across jobs — the Mutation workflow has one
            // job today, but matrix expansions would spread the step
            // across multiple jobs. Take the max per run defensively.
            let runMax: number | null = null
            for (const job of parsed.jobs ?? []) {
              for (const step of job.steps ?? []) {
                if (step.name !== stepName) continue
                const duration = computeStepDurationMinutes(step.started_at, step.completed_at)
                if (duration === null) continue
                if (runMax === null || duration > runMax) runMax = duration
              }
            }
            if (runMax !== null) durations.push(runMax)
          } catch {
            // Skip the individual run on gh-api failure; other runs
            // may still yield data.
          }
        }
        return durations
      } catch {
        return []
      }
    },

    async countMutationIssues(modulePath, sinceDays) {
      if (!opts.ghRepo) return { total: 0, closedMerged: 0 }
      try {
        const basename = modulePath.split('/').pop() ?? modulePath
        // Mutation-watcher issues mention "mutation" + the basename in title.
        const sinceIso = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10)
        const output = execFileSync(
          'gh',
          [
            'issue',
            'list',
            '--repo',
            opts.ghRepo,
            '--search',
            `mutation ${basename} in:title created:>=${sinceIso}`,
            '--state',
            'all',
            '--json',
            'number,state,stateReason',
            '--limit',
            '50',
          ],
          { cwd: repoRoot, encoding: 'utf-8' },
        )
        const issues = JSON.parse(output) as Array<{ number: number; state: string; stateReason: string | null }>
        const total = issues.length
        const closedMerged = issues.filter(i => i.state === 'CLOSED' && i.stateReason !== 'not_planned').length
        return { total, closedMerged }
      } catch {
        return { total: 0, closedMerged: 0 }
      }
    },
  }
}
