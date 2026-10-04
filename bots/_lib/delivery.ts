/**
 * Delivery — push an approved branch and keep its work if the push fails.
 *
 * Shared by feature-bot, fix-bot and dead-code-watcher (rule 15: three
 * callers). Each bot used to have its own `pushBranch` that caught the git
 * error, printed a warning and returned `void`; the caller then opened a PR
 * and reported success regardless. A rejected push therefore discarded
 * reviewer-approved work while every surface a human checks said "done"
 * (#840). The deterministic trigger is a cut that edits
 * `.github/workflows/**`, which `GITHUB_TOKEN` cannot push under any
 * permission — but auth expiry, branch protection, a lease conflict or a
 * network blip all took the same silent path.
 *
 * So `pushBranch` returns a result the caller MUST branch on, and
 * `savePatch` preserves the approved commits before anything (an
 * escalation's reset-to-main) throws them away.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type DeliveryResult = { ok: true } | { ok: false; error: string }

/**
 * Run a command, echo its stderr to the log either way (a successful push
 * prints the PR hint there), and return the outcome instead of throwing.
 */
function run(cmd: string, args: readonly string[], cwd: string): DeliveryResult {
  const r = spawnSync(cmd, [...args], { cwd, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf-8' })
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status === 0) return { ok: true }
  const error = (r.stderr?.trim() || r.error?.message || `${cmd} exited with ${r.status ?? r.signal}`).slice(0, 2000)
  return { ok: false, error }
}

/**
 * Push `branch` to origin. `forceWithLease` for bot-owned branches rebuilt
 * fresh each attempt (a stale leftover must be replaced, #550); lease still
 * refuses to clobber a push we did not expect.
 *
 * stderr is captured so the actual reason ("refusing to allow a GitHub App
 * to create or update workflow ...") reaches the escalation.
 */
export function pushBranch(branch: string, opts: { cwd: string; forceWithLease: boolean }): DeliveryResult {
  return run('git', ['push', '-u', ...(opts.forceWithLease ? ['--force-with-lease'] : []), 'origin', branch], opts.cwd)
}

/** Run `gh` and report the outcome instead of swallowing it. */
export function runGh(args: readonly string[], cwd: string): DeliveryResult {
  return run('gh', args, cwd)
}

export interface SavedPatch {
  /** Absolute path of the written .patch file. */
  path: string
  /** The patch text (git format-patch --stdout of base..branch). */
  text: string
}

/**
 * Write the commits on `branch` that are not on `base` as a git-am-able patch
 * into `dir` (each bot passes its transcripts dir, which the workflow
 * uploads as a 90-day artifact). Returns null when there is nothing to
 * save or git fails — callers still escalate, they just can't attach work.
 */
export function savePatch(o: {
  cwd: string
  dir: string
  name: string
  branch: string
  base?: string
}): SavedPatch | null {
  try {
    const text = execFileSync('git', ['format-patch', `${o.base ?? 'origin/main'}..${o.branch}`, '--stdout'], {
      cwd: o.cwd,
      maxBuffer: 64 * 1024 * 1024,
    }).toString()
    if (text.trim() === '') return null
    const path = resolve(o.dir, `${o.name}.patch`)
    writeFileSync(path, text)
    return { path, text }
  } catch {
    return null
  }
}

/** A backtick fence longer than any backtick run in `text`, so it can't close early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(r => r.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Inline patches only below this — GitHub comments cap at 65,536 chars. */
export const INLINE_PATCH_LIMIT = 40_000

/**
 * Comment body that hands approved-but-undelivered work to a human.
 * Plain language (rule 23): what was approved, why it didn't land, where the
 * work is, and the exact command to apply it.
 */
export function deliveryFailureComment(o: {
  bot: string
  issueNumber: number
  stage: 'push' | 'pr'
  branch: string
  error: string
  patch: SavedPatch | null
  patchFileName: string | null
  runUrl: string
  runId: string
}): string {
  const what =
    o.stage === 'push'
      ? `The reviewer **approved** this work, but pushing branch \`${o.branch}\` was rejected, so no PR could be opened.`
      : `The reviewer **approved** this work and branch \`${o.branch}\` was pushed, but opening the PR failed. Open it by hand from that branch.`
  const where =
    o.stage === 'pr'
      ? ''
      : o.patch
        ? `\n\n**The work is preserved** as \`${o.patchFileName}\` in this run's transcripts artifact (${o.runUrl}). Apply it with \`git am < ${o.patchFileName}\`.`
        : `\n\nThe work could not be saved as a patch; see the transcripts for this run (${o.runUrl}).`
  const inline =
    o.stage === 'push' && o.patch && o.patch.text.length <= INLINE_PATCH_LIMIT
      ? `\n\n<details><summary>Patch (${o.patch.text.length} chars)</summary>\n\n${fenceFor(o.patch.text)}diff\n${o.patch.text}\n${fenceFor(o.patch.text)}\n\n</details>`
      : ''
  const errFence = fenceFor(o.error)
  return `> *This was generated by AI during a ${o.bot} run.*

⚠ **Approved, but not delivered.** ${what}

**Git said:**

${errFence}
${o.error.trim()}
${errFence}${where}${inline}

If the error mentions a workflow file: the bots push with \`GITHUB_TOKEN\`, which cannot modify \`.github/workflows/**\` (#840) — this change needs a human PR.

<!-- ${o.bot}: delivery-failed issue=${o.issueNumber} stage=${o.stage} run=${o.runId} -->`
}
