/**
 * gazetta.studio's Contribute page and the home page's main button
 * (docs/audits/website-and-channels.md Stage 0, decided on #1270).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTemplate } from '../src/template-loader.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const site = resolve(repoRoot, 'sites/gazetta.studio')
const pagesDir = resolve(site, 'targets/local/pages')
const templatesDir = resolve(site, 'templates')

const REVIEW_PATHS = [
  'packages/gazetta/src/auth/',
  'packages/gazetta/src/admin-api/middleware/',
  'packages/gazetta/src/providers/',
  'packages/gazetta/src/workers/',
  'packages/gazetta/src/public-site-path.ts',
  '.github/workflows/',
  'bots/',
]

interface Component {
  name?: string
  template?: string
  content?: Record<string, unknown>
  components?: (string | Component)[]
}

function readPage(name: string): Component {
  return JSON.parse(readFileSync(resolve(pagesDir, name, 'page.json'), 'utf-8')) as Component
}

function findComponent(c: Component, name: string): Component | undefined {
  for (const child of c.components ?? []) {
    if (typeof child === 'string') continue
    if (child.name === name) return child
    const found = findComponent(child, name)
    if (found) return found
  }
  return undefined
}

describe('gazetta.studio Contribute page', () => {
  it('exists', () => {
    expect(existsSync(resolve(pagesDir, 'contribute/page.json'))).toBe(true)
  })

  it('covers every item the issue lists', () => {
    const text = readFileSync(resolve(pagesDir, 'contribute/page.json'), 'utf-8')
    expect(text).toContain('ready-for-agent')
    for (const path of REVIEW_PATHS) expect(text).toContain(path)
    expect(text).toMatch(/within 2 days/)
    expect(text).toContain('https://github.com/gazetta-studio/gazetta-studio/contribute')
    expect(text).toContain('.claude/rules/')
    expect(text).toContain('https://github.com/gazetta-studio/gazetta-studio/graphs/contributors')
  })

  it('has a "Try it" section that runs Gazetta from main', () => {
    const tryIt = findComponent(readPage('contribute'), 'try-it')
    expect(tryIt?.content?.id).toBe('try-it')
    const text = JSON.stringify(tryIt)
    expect(text).toContain('git clone https://github.com/gazetta-studio/gazetta-studio.git')
    expect(text).toContain('npm install')
    expect(text).toContain('npm run dev')
    expect(text).toContain('localhost:3000/admin')
  })

  it('renders its section ids so the "Try it" link lands on the section', async () => {
    const section = await loadTemplate(undefined, templatesDir, 'section')
    const output = await section.render({ content: { id: 'try-it', heading: 'Try it' }, children: [] } as never)
    expect(String(output.html)).toContain('id="try-it"')
  })
})

describe('gazetta.studio home page', () => {
  it('has Contribute as its main button and a smaller "Try it" beside it', async () => {
    const hero = findComponent(readPage('home'), 'hero')
    expect(hero?.content).toMatchObject({
      cta: 'Contribute',
      ctaHref: '/contribute',
      secondary: 'Try it',
      secondaryHref: '/contribute#try-it',
    })
    const template = await loadTemplate(undefined, templatesDir, 'hero')
    const html = String((await template.render({ content: hero?.content } as never)).html)
    expect(html).toContain('<a href="/contribute" class="hero-cta">Contribute</a>')
    expect(html).toContain('<a href="/contribute#try-it" class="hero-secondary">Try it</a>')
  })
})

describe('CONTRIBUTING.md', () => {
  const contributing = readFileSync(resolve(repoRoot, 'CONTRIBUTING.md'), 'utf-8')

  it('lists the paths the maintainer reviews personally', () => {
    for (const path of REVIEW_PATHS) expect(contributing).toContain(path)
  })

  it('states the PR response time', () => {
    expect(contributing).toMatch(/within 2 days/)
  })
})
