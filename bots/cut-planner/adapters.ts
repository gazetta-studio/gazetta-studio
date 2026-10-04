/**
 * Real implementations of the executor's ports: octokit for GitHub, the
 * Claude CLI for planning. All of cut-planner's I/O lives here and in
 * index.ts; everything else is pure or port-injected.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectRateLimit, detectTransientAuthError, runClaude } from '../_lib/claude.js'
import { addLabel, octokitFromEnv, type RepoIdentity, removeLabel } from '../_lib/github.js'
import { collectAssistantTexts } from '../_lib/transcript.js'
import type { GitHubPort, PlanContext, PlannerPort, PlannerResult } from './execute.js'
import type { Mode } from './plan-output.js'
import { composePrompt, type PromptTemplates } from './prompt.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')

export function octokitGitHub(octokit: ReturnType<typeof octokitFromEnv>, repo: RepoIdentity): GitHubPort {
  return {
    async getIssue(n) {
      const { data } = await octokit.issues.get({ ...repo, issue_number: n })
      return {
        title: data.title,
        body: data.body ?? '',
        labels: data.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))),
      }
    },
    async listCommentBodies(n) {
      const all = await octokit.paginate(octokit.issues.listComments, { ...repo, issue_number: n, per_page: 100 })
      return all.map(c => c.body ?? '')
    },
    async createIssue(title, body, labels) {
      const { data } = await octokit.issues.create({ ...repo, title, body, labels: [...labels] })
      return data.number
    },
    async updateBody(n, body) {
      await octokit.issues.update({ ...repo, issue_number: n, body })
    },
    async comment(n, body) {
      await octokit.issues.createComment({ ...repo, issue_number: n, body })
    },
    async addLabel(n, label) {
      await addLabel(octokit, repo, n, label)
    },
    async removeLabel(n, label) {
      // 404 (label not present) is the expected no-op; anything else throws.
      await removeLabel(octokit, repo, n, label)
    },
    async close(n, reason) {
      await octokit.issues.update({ ...repo, issue_number: n, state: 'closed', state_reason: reason })
    },
  }
}

export function loadTemplates(): PromptTemplates {
  const read = (f: string) => readFileSync(resolve(HERE, 'prompts', f), 'utf-8')
  return {
    context: read('_context.md'),
    contract: read('_contract.md'),
    modes: { file: read('file.md'), refine: read('refine.md'), redecompose: read('redecompose.md') },
  }
}

/**
 * One Claude call per action. Read-only tools: cut-planner names files and
 * tests by reading code, but it writes nothing to the repo — every write it
 * makes is an issue write, done by TS through the GitHub port.
 */
export function claudePlanner(templates: PromptTemplates, runTimestamp: string): PlannerPort {
  return {
    async plan(mode: Mode, context: PlanContext): Promise<PlannerResult> {
      mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
      const subject = context.cut ? `cut-${context.cut.number}` : `planner-${context.plannerIssueNumber}`
      const transcriptPath = resolve(TRANSCRIPTS_DIR, `${runTimestamp}-cut-planner-${mode}-${subject}.jsonl`)
      const result = await runClaude({
        prompt: composePrompt(templates, mode, context),
        transcriptPath,
        allowedTools: ['Read', 'Grep', 'Glob'],
      })
      // Checked before `success`: a rate-limited run can exit 0 with nothing
      // useful in it, and must still read as "come back later".
      if (detectRateLimit(transcriptPath) || detectTransientAuthError(transcriptPath)) return { kind: 'quota' }
      if (!result.success) return { kind: 'failed', reason: `claude exited ${result.exitCode}` }
      return { kind: 'ok', texts: collectAssistantTexts(transcriptPath) }
    },
  }
}
