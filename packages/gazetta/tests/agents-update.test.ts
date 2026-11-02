/**
 * `gazetta agents update` and the `gazetta dev` hint (design-agent-access.md
 * Q33, Q34, #1735): the section functions and the update core.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { agentsSectionHint, replaceAgentsSection, sectionVersion } from '../src/cli/agents-section.js'
import { describeAgentsUpdate, findGazettaProject, updateAgents } from '../src/cli/agents-update.js'
import { tempDir } from './_helpers/temp.js'

const section = (version: string) =>
  `<!-- gazetta:agents start version=${version} -->\n## Gazetta\nUse gz.\n<!-- gazetta:agents end -->\n`
const before = '# My project\n\nOur own notes.\n\n'
const after = '\n## Testing\n\nRun npm test.\n'

describe('replaceAgentsSection', () => {
  it('replaces only the section, leaving the text around it byte for byte', () => {
    const update = replaceAgentsSection(before + section('0.7.0') + after, section('0.8.0'))
    expect(update).toEqual({ content: before + section('0.8.0') + after, change: 'updated', from: '0.7.0' })
  })

  it('appends a section to an AGENTS.md without one, and writes one where there is no file', () => {
    expect(replaceAgentsSection('# Mine\n', section('0.8.0'))).toEqual({
      content: `# Mine\n\n${section('0.8.0')}`,
      change: 'added',
    })
    expect(replaceAgentsSection(undefined, section('0.8.0'))).toEqual({ content: section('0.8.0'), change: 'added' })
  })

  it('reports a section that is already the package’s as current', () => {
    const text = before + section('0.8.0') + after
    expect(replaceAgentsSection(text, section('0.8.0'))).toEqual({ content: text, change: 'current', from: '0.8.0' })
  })

  it('refuses a start marker without an end marker rather than guess', () => {
    expect(() =>
      replaceAgentsSection(`${before}<!-- gazetta:agents start version=0.7.0 -->\nhalf`, section('0.8.0')),
    ).toThrow(/no "<!-- gazetta:agents end -->"/)
  })
})

describe('the gazetta dev hint', () => {
  it.each([
    [
      'an older section',
      before + section('0.7.0'),
      "AGENTS.md has Gazetta's agent section from 0.7.0; run `gazetta agents update`.",
    ],
    ['a current section', before + section('0.8.0'), null],
    [
      'no section in an existing AGENTS.md',
      before,
      'AGENTS.md has no Gazetta agent section; run `gazetta agents update`.',
    ],
    ['no AGENTS.md', undefined, null],
  ])('%s', (_name, text, expected) => {
    expect(agentsSectionHint(text, '0.8.0')).toBe(expected)
  })

  it('reads the version from the start marker', () => {
    expect(sectionVersion(section('0.8.0'))).toBe('0.8.0')
    expect(sectionVersion('<!-- gazetta:agents start -->')).toBeNull()
    expect(sectionVersion(before)).toBeUndefined()
  })
})

describe('updateAgents', () => {
  let dir: string
  const pkgRoot = () => {
    const root = join(dir, 'pkg')
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(join(root, 'agents', 'AGENTS.md'), section('0.8.0'))
    return root
  }
  const project = (files: Record<string, string>) => {
    const root = join(dir, 'site')
    mkdirSync(join(root, 'sites', 'main'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { gazetta: '^0.8.0' } }))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
    return root
  }
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('updates the section, adds the CLAUDE.md import once, and is current on a second run', () => {
    dir = tempDir(`agents-update-${Date.now()}-${Math.random()}`)
    const site = project({ 'AGENTS.md': before + section('0.7.0') + after, 'CLAUDE.md': '# Claude\n' })
    const first = updateAgents(site, pkgRoot())
    expect(first).toMatchObject({ change: 'updated', from: '0.7.0', claudeImportAdded: true })
    expect(readFileSync(join(site, 'AGENTS.md'), 'utf-8')).toBe(before + section('0.8.0') + after)
    expect(readFileSync(join(site, 'CLAUDE.md'), 'utf-8')).toBe(
      '# Claude\n\n<!-- gazetta:agents import -->\n@AGENTS.md\n',
    )
    expect(describeAgentsUpdate(first, '0.8.0')).toContain(
      'Ask your coding agent to reinstall the Gazetta skill from node_modules/gazetta/agents/.',
    )

    const second = updateAgents(site, pkgRoot())
    expect(second).toMatchObject({ change: 'current', claudeImportAdded: false })
    expect(describeAgentsUpdate(second, '0.8.0')).toEqual(["AGENTS.md: Gazetta's section is already current (0.8.0)."])
  })

  it('leaves an existing CLAUDE.md import alone, and adds none without a CLAUDE.md', () => {
    dir = tempDir(`agents-update-${Date.now()}-${Math.random()}`)
    const claude = '# Claude\n@AGENTS.md\n'
    const site = project({ 'AGENTS.md': before, 'CLAUDE.md': claude })
    expect(updateAgents(site, pkgRoot())).toMatchObject({ change: 'added', claudeImportAdded: false })
    expect(readFileSync(join(site, 'CLAUDE.md'), 'utf-8')).toBe(claude)
    const bare = join(dir, 'bare')
    mkdirSync(bare)
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ devDependencies: { gazetta: '*' } }))
    expect(updateAgents(bare, pkgRoot())).toMatchObject({ change: 'added', claudeImportAdded: false })
  })

  it('finds the project from a folder inside it, and none outside one', () => {
    dir = tempDir(`agents-update-${Date.now()}-${Math.random()}`)
    const site = project({})
    expect(findGazettaProject(join(site, 'sites', 'main'))).toBe(site)
    const other = join(dir, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }))
    expect(findGazettaProject(other)).not.toBe(other)
  })
})
