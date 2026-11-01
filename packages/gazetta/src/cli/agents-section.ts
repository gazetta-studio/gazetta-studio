import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Starts the section Gazetta owns in a project's AGENTS.md (the marker carries the version). */
export const AGENTS_SECTION_START = '<!-- gazetta:agents start'

/** Marks the import line Gazetta adds to an existing CLAUDE.md. */
export const CLAUDE_IMPORT_MARKER = '<!-- gazetta:agents import -->'

/** The AGENTS.md section shipped in the package (`agents/AGENTS.md`, version stamped at build). */
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
  return append(existing, section)
}

/**
 * The CLAUDE.md content after adding an `@AGENTS.md` import, or `undefined`
 * when it already imports it. Claude Code reads AGENTS.md only when a project
 * has no CLAUDE.md (design-agent-access.md Q34).
 */
export function withClaudeImport(existing: string): string | undefined {
  if (/^@(\.\/)?AGENTS\.md\s*$/m.test(existing)) return undefined
  return append(existing, `${CLAUDE_IMPORT_MARKER}\n@AGENTS.md\n`)
}

function append(existing: string, addition: string): string {
  const separator = existing.length === 0 || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return existing + separator + addition
}
