/**
 * `gazetta targets [site]`: each target with what it keeps and can do,
 * the rows of the admin's "About this target" view
 * (design-public-storage.md, UX check). Reads config only; no target is
 * initialized, so unreachable storage doesn't slow it down.
 */
import { describeTarget } from '../target-capabilities.js'
import type { TargetConfig } from '../types.js'

export interface TargetsCommandContext {
  targetConfigs: Readonly<Record<string, TargetConfig>>
  log?: (line: string) => void
}

export function runTargets(ctx: TargetsCommandContext): void {
  const log = ctx.log ?? (line => console.log(line))
  log('')
  for (const [name, config] of Object.entries(ctx.targetConfigs)) {
    const rows = describeTarget(name, config, ctx.targetConfigs)
    const width = Math.max(...rows.map(r => r.label.length))
    log(`  ${name}`)
    for (const row of rows) log(`    ${row.label.padEnd(width)}  ${row.value}`)
    log('')
  }
}
