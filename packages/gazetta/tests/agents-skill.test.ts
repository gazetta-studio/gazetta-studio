/**
 * The agent skill and AGENTS.md section shipped in `agents/` (#1622,
 * design-agent-access.md Q4, Q31, Q32, Q34): init writes the section without
 * overwriting the person's text, the never-run list matches every command and
 * admin route that publishes or deploys, deletes content or rewrites a
 * target's history, and the commands, flags and template API the skill names
 * still exist.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import {
  AGENTS_SECTION_START,
  CLAUDE_IMPORT_MARKER,
  withAgentsSection,
  withClaudeImport,
} from '../src/cli/agents-section.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'
import { tempDir } from './_helpers/temp.js'

const packageRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(packageRoot, '../..')
const cli = join(packageRoot, 'dist/cli/index.js')
const skill = readFileSync(join(packageRoot, 'agents/gazetta/SKILL.md'), 'utf-8')
const section = readFileSync(join(packageRoot, 'agents/AGENTS.md'), 'utf-8')
const { version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as { version: string }

/**
 * Every CLI command and every admin route that changes state, sorted by
 * Q32's rule: `never` publishes or deploys, deletes content or rewrites a
 * target's history (or approves a request); `allowed` is everything else.
 * A new command or route fails the test until it's added here.
 */
const COMMANDS: Record<string, 'never' | 'allowed'> = {
  init: 'allowed',
  dev: 'allowed',
  build: 'allowed',
  admin: 'allowed',
  publish: 'never',
  serve: 'allowed',
  deploy: 'never',
  validate: 'allowed',
  translate: 'allowed',
  history: 'allowed',
  undo: 'never',
  rollback: 'never',
  'assets list': 'allowed',
  'assets info': 'allowed',
  'assets reindex': 'allowed',
  'archive list': 'allowed',
  'archive purge': 'never',
  'archive restore': 'allowed',
  'archive rename': 'allowed',
  'state remove': 'never',
  help: 'allowed',
}

const ROUTES: Record<string, 'never' | 'allowed'> = {
  'POST /api/v1/publish': 'never',
  'POST /api/v1/publish/stream': 'never',
  'POST /api/v1/publish/audit': 'allowed',
  'POST /api/v1/fetch': 'never',
  'POST /api/v1/history/undo': 'never',
  'POST /api/v1/history/restore': 'never',
  'POST /api/v1/pages': 'allowed',
  'PUT /api/v1/pages/:name': 'allowed',
  'DELETE /api/v1/pages/:name': 'never',
  'DELETE /api/v1/pages/:name/purge': 'never',
  'POST /api/v1/pages/:name/archive': 'allowed',
  'POST /api/v1/pages/:name/unarchive': 'allowed',
  'POST /api/v1/pages/:name/rename': 'allowed',
  'PATCH /api/v1/pages/:name/alias': 'allowed',
  'POST /api/v1/fragments': 'allowed',
  'PUT /api/v1/fragments/:name': 'allowed',
  'DELETE /api/v1/fragments/:name': 'never',
  'DELETE /api/v1/fragments/:name/purge': 'never',
  'POST /api/v1/fragments/:name/archive': 'allowed',
  'POST /api/v1/fragments/:name/unarchive': 'allowed',
  'POST /api/v1/fragments/:name/rename': 'allowed',
  'PATCH /api/v1/fragments/:name/alias': 'allowed',
  'POST /api/v1/page-redirects': 'allowed',
  'POST /api/v1/fragment-redirects': 'allowed',
  'POST /api/v1/assets': 'allowed',
  'PATCH /api/v1/assets/:name': 'allowed',
  'DELETE /api/v1/assets/:name': 'never',
  'POST /api/v1/assets/:name/replace-with/:newName': 'never',
  'POST /api/v1/assets/:name/rename-to/:newName': 'allowed',
  // Removing one language's version is an edit undo covers (Q32).
  'POST /api/v1/assets/:name/locale-bytes': 'allowed',
  'DELETE /api/v1/assets/:name/locale-bytes': 'allowed',
  'POST /api/v1/assets/:name/suggest-alt': 'allowed',
  // Approving a CLI login is the person's own step in the browser (Q19);
  // starting, redeeming and renewing are what `gz` does.
  'POST /api/v1/auth/logins': 'allowed',
  'POST /api/v1/auth/logins/:code/approve': 'never',
  'POST /api/v1/auth/logins/:code/deny': 'never',
  'POST /api/v1/auth/logins/:code/redeem': 'allowed',
  'POST /api/v1/auth/tokens': 'allowed',
  'DELETE /api/v1/auth/grants/:id': 'allowed',
  // Creating a sign-in in the browser is approving one (Q19).
  'POST /api/v1/auth/grants': 'never',
  // Asking for an elevation and ending one are `gz`'s; approving and
  // denying one go through the login approve and deny routes above (Q32).
  'POST /api/v1/auth/elevations': 'allowed',
  'DELETE /api/v1/auth/elevations/:id': 'allowed',
  'POST /preview/*': 'allowed',
}

const never = (table: Record<string, 'never' | 'allowed'>) =>
  Object.keys(table)
    .filter(key => table[key] === 'never')
    .sort()

function helpCommands(): string[] {
  const help = execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf-8' })
  const commands = new Set<string>()
  const usage = help.slice(help.indexOf('Usage:'), help.indexOf('Options:'))
  for (const match of usage.matchAll(/^ {4}gazetta ([a-z-]+)(?: ([a-z-]+))?/gm)) {
    commands.add(match[2] ? `${match[1]} ${match[2]}` : match[1])
  }
  return [...commands].sort()
}

function adminRoutes(): string[] {
  const storage = memoryStorage()
  const targetConfigs = { local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true } }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/p',
    manifest: { name: 's', targets: targetConfigs },
  })
  const app = createAdminApp({
    source,
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  const routes = app.routes
    .filter(route => !['GET', 'HEAD', 'OPTIONS', 'ALL'].includes(route.method))
    .map(route => `${route.method} ${route.path.replace('{.+}', '')}`)
  return [...new Set(routes)].sort()
}

/** The backticked entries of a markdown list, in the given text. */
function listed(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(/^- `([^`]+)`$/gm)]
    .map(match => match[1])
    .filter(entry => pattern.test(entry))
    .sort()
}

const neverRunPart = (text: string) => text.slice(text.indexOf('ever run these'))
const commandEntries = (text: string) => listed(neverRunPart(text), /^gazetta /).map(entry => entry.slice(8))
const routeEntries = (text: string) => listed(neverRunPart(text), /^[A-Z]+ \//)

// These run the built CLI or the TypeScript compiler: seconds each on loaded CI runners.
describe('the never-run list (Q32)', { timeout: 60_000 }, () => {
  it('sorts every CLI command, and lists exactly the never ones in the skill and AGENTS.md', () => {
    expect(helpCommands()).toEqual(Object.keys(COMMANDS).sort())
    expect(commandEntries(skill)).toEqual(never(COMMANDS))
    expect(commandEntries(section)).toEqual(never(COMMANDS))
  })

  it('sorts every admin route that changes state, and lists exactly the never ones', () => {
    expect(adminRoutes()).toEqual(Object.keys(ROUTES).sort())
    expect(routeEntries(skill)).toEqual(never(ROUTES))
    expect(routeEntries(section)).toEqual(never(ROUTES))
  })
})

describe('skill drift (Q4)', { timeout: 60_000 }, () => {
  it('names only commands and flags the CLI has', () => {
    const commands = new Set(helpCommands())
    const named = [...skill.matchAll(/`gazetta ([a-z-]+)(?: ([a-z-]+))?/g)].map(match =>
      match[2] && commands.has(`${match[1]} ${match[2]}`) ? `${match[1]} ${match[2]}` : match[1],
    )
    expect(named.length).toBeGreaterThan(0)
    for (const command of named) expect(commands, command).toContain(command)

    const flagSources = [
      execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf-8' }),
      readFileSync(join(packageRoot, 'src/cli/validate-flags.ts'), 'utf-8'),
      readFileSync(join(packageRoot, 'src/cli/args.ts'), 'utf-8'),
    ].join('\n')
    for (const [flag] of skill.matchAll(/--[a-z][a-z-]+/g)) expect(flagSources, flag).toContain(flag)
  })

  it('names only exports the package has', async () => {
    const modules: Record<string, Record<string, unknown>> = {
      gazetta: await import('../src/index.js'),
      'gazetta/editor': await import('../src/editor/mount.js'),
      'gazetta/schema': await import('../src/schema/index.js'),
    }
    // Value exports the skill tells agents to use.
    expect(modules['gazetta/schema'].embeddedAsset).toBeTypeOf('function')
    expect(modules['gazetta/editor'].DefaultEditorForm).toBeDefined()
    const format = modules.gazetta.format as Record<string, unknown>
    for (const [, helper] of skill.matchAll(/format\.([a-z]+)\(/g)) expect(format, helper).toHaveProperty(helper)
  })

  it("type-checks the skill's template example against the package", () => {
    const example = skill.match(/```ts\n(\/\/ templates\/hero\/index\.ts[\s\S]*?)```/)?.[1]
    expect(example).toBeDefined()
    expect(diagnose(example!)).toEqual([])
    expect(diagnose(example!.replace('content?.title', 'content?.titel')).join('\n')).toContain('titel')
  })
})

/** Type errors in `source`, compiled strictly against this repo's gazetta and zod types. */
function diagnose(source: string): string[] {
  const file = join(packageRoot, '__agents_skill_example__.ts')
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: [],
  }
  const pinned: Record<string, string> = {
    gazetta: join(packageRoot, 'dist/index.d.ts'),
    'gazetta/schema': join(packageRoot, 'dist/schema/index.d.ts'),
    zod: join(repoRoot, 'node_modules/zod/index.d.cts'),
  }
  const host = ts.createCompilerHost(options)
  const readSource = host.readFile.bind(host)
  host.readFile = path => (path === file ? source : readSource(path))
  host.fileExists = (
    exists => (path: string) =>
      path === file || exists(path)
  )(host.fileExists.bind(host))
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map(literal => {
      const target = pinned[literal.text]
      if (target) {
        const extension = target.endsWith('.d.cts') ? ts.Extension.Dcts : ts.Extension.Dts
        return { resolvedModule: { resolvedFileName: target, extension, isExternalLibraryImport: true } }
      }
      return { resolvedModule: ts.resolveModuleName(literal.text, containingFile, options, host).resolvedModule }
    })
  const program = ts.createProgram({ rootNames: [file], options, host })
  return ts
    .getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

describe('AGENTS.md section (Q31, Q34)', () => {
  it('starts with the marker, and adds it only when missing, after the person’s text', () => {
    expect(section.startsWith(AGENTS_SECTION_START)).toBe(true)
    expect(withAgentsSection(undefined, section)).toBe(section)
    expect(withAgentsSection('# My notes\n', section)).toBe(`# My notes\n\n${section}`)
    expect(withAgentsSection('# My notes', section)).toBe(`# My notes\n\n${section}`)
    expect(withAgentsSection(`# Mine\n\n${section}`, section)).toBeUndefined()
    // An older section (another version in its marker) still counts as present.
    expect(withAgentsSection(section.replaceAll(version, '0.0.1'), section)).toBeUndefined()
  })

  it('carries the package version in the section and the skill (Q33, Q34)', () => {
    expect(section.split('\n')[0]).toBe(`${AGENTS_SECTION_START} version=${version} -->`)
    expect(section).toContain(`Gazetta ${version}`)
    expect(skill).toContain(`gazetta-version: "${version}"`)
    expect(section + skill).not.toContain('{{version}}')
  })

  it('adds the @AGENTS.md import to a CLAUDE.md only when missing', () => {
    expect(withClaudeImport('# Notes\n')).toBe(`# Notes\n\n${CLAUDE_IMPORT_MARKER}\n@AGENTS.md\n`)
    expect(withClaudeImport('# Notes\n\n@AGENTS.md\n')).toBeUndefined()
    expect(withClaudeImport('@./AGENTS.md')).toBeUndefined()
    expect(withClaudeImport('See @AGENTS.md for more.\n')).toBe(
      `See @AGENTS.md for more.\n\n${CLAUDE_IMPORT_MARKER}\n@AGENTS.md\n`,
    )
  })

  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  async function init(prepare?: (site: string) => Promise<void>): Promise<string> {
    const parent = tempDir(`agents-init-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    dirs.push(parent)
    const bin = join(parent, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n')
    await chmod(join(bin, 'npm'), 0o755)
    const site = join(parent, 'site')
    await mkdir(site, { recursive: true })
    await prepare?.(site)
    execFileSync(process.execPath, [cli, 'init', site], {
      env: { ...process.env, CI: 'true', PATH: `${bin}:${process.env.PATH}` },
      stdio: 'pipe',
      timeout: 60000,
    })
    return site
  }

  it('writes the section in a new project and no skill file', async () => {
    const site = await init()
    expect(await readFile(join(site, 'AGENTS.md'), 'utf-8')).toBe(section)
    for (const folder of ['.claude', '.agents', '.codex', '.cursor', '.github'])
      expect(existsSync(join(site, folder)), folder).toBe(false)
  }, 90000)

  it('appends the section to an existing AGENTS.md without changing its text', async () => {
    const site = await init(dir => writeFile(join(dir, 'AGENTS.md'), '# House rules\n\nUse tabs.\n'))
    expect(await readFile(join(site, 'AGENTS.md'), 'utf-8')).toBe(`# House rules\n\nUse tabs.\n\n${section}`)
  }, 90000)

  it('adds the import line to an existing CLAUDE.md and creates none otherwise', async () => {
    const withClaude = await init(dir => writeFile(join(dir, 'CLAUDE.md'), '# Project\n'))
    expect(await readFile(join(withClaude, 'CLAUDE.md'), 'utf-8')).toBe(
      `# Project\n\n${CLAUDE_IMPORT_MARKER}\n@AGENTS.md\n`,
    )
    expect(existsSync(join(await init(), 'CLAUDE.md'))).toBe(false)
  }, 90000)
})
