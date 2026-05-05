/**
 * CLI history commands.
 *
 *   gazetta history [target]           — list revisions, newest first
 *   gazetta undo [target]              — restore the revision just before
 *                                        head (the "undo last write" shortcut)
 *   gazetta rollback <rev> [target]    — restore an arbitrary revision by id
 *
 * All three reuse the admin-api's HistoryProvider + restoreRevision —
 * CLI and web surface the same operations. SRP: this file glues the
 * CLI to the core; no new domain logic.
 *
 * Destructive ops (undo, rollback) prompt for confirmation on prod
 * targets when running interactively. `CI=true` disables the prompt
 * and fails if `--yes` wasn't passed.
 */

import { createInterface } from 'node:readline/promises'
import { createHistoryProvider } from '../history-provider.js'
import { restoreRevision } from '../history-restorer.js'
import { createContentRoot } from '../content-root.js'
import { isHistoryEnabled, getHistoryRetention, getEnvironment } from '../types.js'
import type { TargetConfig } from '../types.js'

/** Shared context passed to every command handler. */
export interface HistoryCommandContext {
  siteDir: string
  targetName: string
  config: TargetConfig
}

/** Format an ISO timestamp as "Apr 16, 2026 · 11:05" for humans. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(',', ' ·')
}

/** Abbreviate an items list for single-line display. */
function formatItems(items: readonly string[]): string {
  if (items.length === 0) return '(none)'
  if (items.length <= 3) return items.join(', ')
  return `${items.slice(0, 3).join(', ')} + ${items.length - 3} more`
}

/**
 * Buid a HistoryProvider for the given target. Throws with a friendly
 * message when history is disabled — prevents the CLI from silently
 * returning an empty list for a target the user explicitly targeted.
 */
async function buildHistory(ctx: HistoryCommandContext) {
  if (!isHistoryEnabled(ctx.config)) {
    throw new Error(`History disabled on target "${ctx.targetName}" (site.config.ts: history.enabled: false)`)
  }
  // Storage is already a constructed provider (Path X — operator-facing
  // factory ran at config-eval). Init the connection if the provider
  // exposes one (S3 + Azure use this for connectivity probes).
  const storage = ctx.config.storage
  const maybeInit = storage as typeof storage & { init?: () => Promise<void> }
  if (typeof maybeInit.init === 'function') await maybeInit.init()
  const history = createHistoryProvider({ storage, retention: getHistoryRetention(ctx.config) })
  const contentRoot = createContentRoot(storage)
  return { history, contentRoot, storage }
}

/**
 * `gazetta history [target]` — print the revision list, newest first.
 */
export async function runHistoryList(ctx: HistoryCommandContext, opts: { limit?: number } = {}): Promise<void> {
  const { history } = await buildHistory(ctx)
  const revisions = await history.listRevisions(opts.limit ?? 50)
  if (revisions.length === 0) {
    console.log(`\n  No revisions on "${ctx.targetName}" yet. Saves and publishes will record here.\n`)
    return
  }

  console.log(`\n  History — ${ctx.targetName} (${revisions.length} revision${revisions.length === 1 ? '' : 's'})\n`)
  for (const rev of revisions) {
    const op = rev.operation.padEnd(8)
    const time = formatTimestamp(rev.timestamp)
    const suffix = rev.source ? `  (from ${rev.source})` : ''
    const message = rev.message ? `  — ${rev.message}` : ''
    console.log(`    ${rev.id}  ${op}  ${time}${suffix}${message}`)
    console.log(`      items: ${formatItems(rev.items)}`)
  }
  console.log()
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase()
    return ans === 'y' || ans === 'yes'
  } finally {
    rl.close()
  }
}

/**
 * Production targets require explicit confirmation. In CI (`CI=true`)
 * the only way to confirm is `--yes` — we never prompt a non-tty.
 */
async function confirmDestructive(ctx: HistoryCommandContext, action: string, flagYes: boolean): Promise<boolean> {
  const isProd = getEnvironment(ctx.config) === 'production'
  if (!isProd) return true
  if (flagYes) return true
  if (process.env.CI) {
    throw new Error(`${action} on production target "${ctx.targetName}" in CI requires --yes to proceed`)
  }
  return confirm(`  ${action} on production target "${ctx.targetName}" — continue?`)
}

/**
 * `gazetta undo [target]` — restore the revision just before head.
 * Needs at least two revisions (baseline + one write). Records a
 * forward rollback.
 */
export async function runHistoryUndo(ctx: HistoryCommandContext, opts: { yes?: boolean } = {}): Promise<void> {
  const { history, contentRoot } = await buildHistory(ctx)
  const recent = await history.listRevisions(2)
  if (recent.length < 2) {
    throw new Error(`Nothing to undo — no prior revision on "${ctx.targetName}"`)
  }
  const [head, prior] = recent
  const proceed = await confirmDestructive(ctx, 'Undo', !!opts.yes)
  if (!proceed) {
    console.log('  Cancelled.')
    return
  }
  const restored = await restoreRevision({
    history,
    contentRoot,
    revisionId: prior.id,
    message: `Undo ${head.operation} (rev ${head.id})`,
  })
  console.log(
    `\n  ✓ Undone. ${ctx.targetName} is now at ${prior.id} (${prior.operation} @ ${formatTimestamp(prior.timestamp)})`,
  )
  console.log(`    Forward revision: ${restored.id}\n`)
}

/**
 * `gazetta rollback <rev> [target]` — restore an arbitrary revision.
 * Records a forward rollback.
 */
export async function runHistoryRollback(
  ctx: HistoryCommandContext,
  revisionId: string,
  opts: { yes?: boolean } = {},
): Promise<void> {
  if (!revisionId)
    throw new Error('rollback: missing revision id (pass as positional, e.g. gazetta rollback rev-1776337441608)')
  const { history, contentRoot } = await buildHistory(ctx)
  // Fail early if the revision doesn't exist — readRevision gives a
  // clear ENOENT-style error otherwise, but we can frame it better here.
  let target
  try {
    target = await history.readRevision(revisionId)
  } catch {
    throw new Error(`Unknown revision "${revisionId}" on target "${ctx.targetName}"`)
  }
  const proceed = await confirmDestructive(ctx, `Rollback to ${revisionId}`, !!opts.yes)
  if (!proceed) {
    console.log('  Cancelled.')
    return
  }
  const restored = await restoreRevision({
    history,
    contentRoot,
    revisionId,
    message: `Rollback to ${revisionId}`,
  })
  console.log(
    `\n  ✓ Rolled back. ${ctx.targetName} is now at ${revisionId} (${target.operation} @ ${formatTimestamp(target.timestamp)})`,
  )
  console.log(`    Forward revision: ${restored.id}\n`)
}
