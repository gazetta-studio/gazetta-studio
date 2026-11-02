/**
 * #1760: `gazetta validate`'s flags agree in three places: the parser,
 * `--help` (from `VALIDATE_FLAGS`) and `docs/cli.md`'s validate table.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseValidateFlags, VALIDATE_FLAGS } from '../src/cli/validate-flags.js'

const here = dirname(fileURLToPath(import.meta.url))
const cliDoc = readFileSync(resolve(here, '../../../docs/cli.md'), 'utf-8')

/** The long flags in the first column of the table under `### \`gazetta validate`. */
function documentedFlags(): string[] {
  const section = cliDoc.split('\n### ').find(s => s.startsWith('`gazetta validate'))
  if (!section) throw new Error('docs/cli.md has no `gazetta validate` section')
  const flags = new Set<string>()
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `-')) continue
    const firstCell = line.split('|')[1]
    for (const m of firstCell.matchAll(/`(--[a-z-]+)/g)) flags.add(m[1])
  }
  return [...flags].sort()
}

// A sample value per flag that takes one, chosen to differ from the default.
const SAMPLE: Record<string, string> = {
  '--severity': 'all',
  '--base': 'origin/main',
  '--targets': 'staging',
  '--format': 'github',
}

describe('gazetta validate flags (#1760)', () => {
  const listed = VALIDATE_FLAGS.map(f => f.flag).sort()

  it('docs/cli.md lists exactly the flags --help lists', () => {
    expect(documentedFlags()).toEqual(listed)
  })

  it.each(VALIDATE_FLAGS.map(f => [f.flag, f.value] as const))('the parser reads %s', (flag, value) => {
    const args = value ? [flag, SAMPLE[flag]] : [flag]
    expect(parseValidateFlags(args)).not.toEqual(parseValidateFlags([]))
  })

  it('the parser reads no flag that --help leaves out', () => {
    // Every `a === '--x'` or `a.startsWith('--x=')` branch of the parser.
    const source = readFileSync(join(here, '../src/cli/validate-flags.ts'), 'utf-8')
    const parsed = [...source.matchAll(/a(?: ===|\.startsWith\() '(--[a-z-]+)/g)].map(m => m[1])
    expect([...new Set(parsed)].sort()).toEqual(listed)
  })

  it('--help prints every flag', () => {
    const help = spawnSync('node', [resolve(here, '../dist/cli/index.js'), 'help'], { encoding: 'utf-8' }).stdout
    for (const flag of listed) expect(help).toMatch(new RegExp(`^    ${flag}\\b`, 'm'))
  })
})
