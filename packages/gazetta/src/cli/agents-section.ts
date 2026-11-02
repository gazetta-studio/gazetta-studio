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

/** Ends the section Gazetta owns in a project's AGENTS.md. */
export const AGENTS_SECTION_END = '<!-- gazetta:agents end -->'

const START_LINE = /<!-- gazetta:agents start(?: version=([^\s>]+))? -->/

/**
 * The version in an AGENTS.md's Gazetta section: the version, `null` for a
 * section without one, `undefined` when there's no section.
 */
export function sectionVersion(text: string): string | null | undefined {
  const m = START_LINE.exec(text)
  return m ? (m[1] ?? null) : undefined
}

export interface SectionUpdate {
  /** The new AGENTS.md content; equal to the old when nothing changed. */
  readonly content: string
  /** `added` when there was no section, `updated` when it changed, `current` when it was already the package's. */
  readonly change: 'added' | 'updated' | 'current'
  /** The version the section had before; null when it had none, undefined when there was no section. */
  readonly from?: string | null
}

/**
 * AGENTS.md with Gazetta's section replaced by the package's (Q33): only the
 * text from the start marker through the end marker changes, so the person's
 * own text around it stays byte for byte. Without a section, it's appended.
 * A start marker without an end marker throws: the section's extent can't
 * be known, and guessing could delete the person's text.
 */
export function replaceAgentsSection(existing: string | undefined, section: string): SectionUpdate {
  const fresh = section.endsWith('\n') ? section : `${section}\n`
  if (existing === undefined) return { content: fresh, change: 'added' }
  const start = START_LINE.exec(existing)
  if (!start) return { content: append(existing, fresh), change: 'added' }
  const endAt = existing.indexOf(AGENTS_SECTION_END, start.index)
  if (endAt === -1) {
    throw new Error(`AGENTS.md has Gazetta's start marker but no "${AGENTS_SECTION_END}" line; fix it by hand`)
  }
  let stop = endAt + AGENTS_SECTION_END.length
  if (existing[stop] === '\n') stop++
  const content = existing.slice(0, start.index) + fresh + existing.slice(stop)
  return { content, change: content === existing ? 'current' : 'updated', from: start[1] ?? null }
}

/**
 * The line `gazetta dev` prints when a project's AGENTS.md has an older
 * Gazetta section than the package, or none at all (Q33); null otherwise,
 * including when there's no AGENTS.md (`gazetta init` writes one).
 */
export function agentsSectionHint(agentsMd: string | undefined, packageVersion: string): string | null {
  if (agentsMd === undefined) return null
  const version = sectionVersion(agentsMd)
  if (version === packageVersion) return null
  const had =
    version === undefined
      ? 'no Gazetta agent section'
      : `Gazetta's agent section from ${version ?? 'an unknown version'}`
  return `AGENTS.md has ${had}; run \`gazetta agents update\`.`
}
