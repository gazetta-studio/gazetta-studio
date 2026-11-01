import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Marks the start of the section Gazetta owns in a project's AGENTS.md. */
export const AGENTS_SECTION_START = '<!-- gazetta:agents start -->'

/** The AGENTS.md section shipped in the package (`agents/AGENTS.md`). */
export function readAgentsSection(packageRoot: string): string {
  return readFileSync(join(packageRoot, 'agents', 'AGENTS.md'), 'utf-8')
}

/**
 * The AGENTS.md content after adding Gazetta's section, or `undefined` when
 * the file already has it. Never rewrites the person's own text: the section
 * is appended after it.
 */
export function withAgentsSection(existing: string | undefined, section: string): string | undefined {
  if (existing === undefined) return section
  if (existing.includes(AGENTS_SECTION_START)) return undefined
  const separator = existing.length === 0 || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return existing + separator + section
}
