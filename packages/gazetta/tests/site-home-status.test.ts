/**
 * gazetta.studio's home page states the project's status, its footer says the
 * site is built and published with Gazetta, and nothing links to the blog (#1269).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTemplate } from '../src/template-loader.js'

const siteDir = resolve(import.meta.dirname, '../../../sites/gazetta.studio')
const templatesDir = resolve(siteDir, 'templates')
const contentDir = resolve(siteDir, 'targets/local')
const readJson = (path: string) => JSON.parse(readFileSync(resolve(contentDir, path), 'utf8'))

function hrefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hrefs)
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) =>
      key.toLowerCase().endsWith('href') && typeof v === 'string' ? [v] : hrefs(v),
    )
  }
  return []
}

describe('gazetta.studio home page', () => {
  it('neither the header nor the footer links to /blog', () => {
    for (const path of ['fragments/header/fragment.json', 'fragments/footer/fragment.json']) {
      const links = hrefs(readJson(path))
      expect(links.length).toBeGreaterThan(0)
      expect(links.filter(href => href.startsWith('/blog'))).toEqual([])
    }
  })

  it('the hero shows a status line linking to the roadmap', async () => {
    const page = readJson('pages/home/page.json')
    const heroComponent = page.components.find((c: { name?: string }) => c?.name === 'hero')
    const hero = await loadTemplate(undefined, templatesDir, 'hero')
    const html = String((await hero.render({ content: heroComponent.content })).html)
    expect(html).toMatch(/<p class="hero-status">[^<]*pre-1\.0[^<]*one person[^<]*breaking changes[^<]*/i)
    expect(html).toContain('href="https://github.com/gazetta-studio/gazetta-studio/blob/main/ROADMAP.md"')
  })

  it('the footer says it is built and published with Gazetta and keeps Claude Code', async () => {
    const footer = await loadTemplate(undefined, templatesDir, 'site-footer')
    const html = String((await footer.render({ children: [] })).html)
    expect(html).toMatch(
      /<a href="https:\/\/github\.com\/gazetta-studio\/gazetta-studio\/tree\/main\/sites\/gazetta\.studio"[^>]*>\s*Built and published with Gazetta\s*<\/a>/,
    )
    expect(html).toContain('Built with Claude Code')
  })
})
