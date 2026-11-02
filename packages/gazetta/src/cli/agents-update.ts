/**
 * `gazetta agents update` (design-agent-access.md Q33, Q34, Q41): refreshes
 * the Gazetta section of an existing project's AGENTS.md from the installed
 * package, and adds the `@AGENTS.md` import to a CLAUDE.md that lacks it.
 * It writes nothing in client folders: the section tells the agent to
 * reinstall the skill from `node_modules/gazetta/agents/`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { claudeImportApplies, readAgentsSection, replaceAgentsSection, withClaudeImport } from './agents-section.js'

/**
 * The nearest folder at or above `from` whose package.json depends on
 * `gazetta`; null when there's none.
 */
export function findGazettaProject(from: string): string | null {
  let dir = resolve(from)
  for (;;) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf-8')) as Record<string, Record<string, string> | undefined>
        if (json.dependencies?.gazetta || json.devDependencies?.gazetta) return dir
      } catch {
        // An unreadable package.json isn't a Gazetta project; keep looking up.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export interface AgentsUpdateResult {
  readonly project: string
  readonly change: 'added' | 'updated' | 'current'
  readonly from?: string | null
  readonly claudeImportAdded: boolean
}

/** Updates the project's agent files; the caller prints the result. */
export function updateAgents(project: string, packageRoot: string): AgentsUpdateResult {
  const agentsPath = join(project, 'AGENTS.md')
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : undefined
  const update = replaceAgentsSection(existing, readAgentsSection(packageRoot))
  if (update.change !== 'current') writeFileSync(agentsPath, update.content)

  const claudePath = join(project, 'CLAUDE.md')
  const claude = claudeImportApplies(claudePath, agentsPath)
    ? withClaudeImport(readFileSync(claudePath, 'utf-8'))
    : undefined
  if (claude !== undefined) writeFileSync(claudePath, claude)

  return {
    project,
    change: update.change,
    ...(update.from !== undefined ? { from: update.from } : {}),
    claudeImportAdded: claude !== undefined,
  }
}

/** The lines `gazetta agents update` prints for a result. */
export function describeAgentsUpdate(result: AgentsUpdateResult, version: string): string[] {
  const lines: string[] = []
  if (result.change === 'current') lines.push(`AGENTS.md: Gazetta's section is already current (${version}).`)
  else if (result.change === 'added') lines.push(`AGENTS.md: added Gazetta's section (${version}).`)
  else lines.push(`AGENTS.md: updated Gazetta's section from ${result.from ?? 'an unknown version'} to ${version}.`)
  if (result.claudeImportAdded) lines.push('CLAUDE.md: added the @AGENTS.md import.')
  if (result.change !== 'current') {
    lines.push('Ask your coding agent to reinstall the Gazetta skill from node_modules/gazetta/agents/.')
  }
  return lines
}
