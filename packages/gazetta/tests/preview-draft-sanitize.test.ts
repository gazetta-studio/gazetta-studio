/**
 * Draft content in the admin preview goes through the same conversion and
 * sanitizing as saved content (design-content-trust.md Q2), so the preview
 * shows what publish would render.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { cp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import { tempDir } from './_helpers/temp.js'

const realStarter = resolve(import.meta.dirname, '../../../examples/starter')
const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true }).catch(() => {})
})

async function starterApp() {
  const projectRoot = tempDir(`preview-draft-sanitize-${Date.now()}-${Math.random()}`)
  roots.push(projectRoot)
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  const projectSiteDir = resolve(projectRoot, 'sites/main')
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error('site.config.ts missing')
  const source = createSourceContext({
    storage: createFilesystemProvider(resolve(projectSiteDir, 'targets/local')),
    siteDir: '',
    projectSiteDir,
    manifest: siteConfigToManifest(loaded.config),
  })
  return createAdminApp({
    source,
    siteDir: projectSiteDir,
    templatesDir: resolve(projectRoot, 'templates'),
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
}

describe('preview draft content', () => {
  it('converts and sanitizes a draft Markdown override', async () => {
    const app = await starterApp()
    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: {
          structural: { 'page:home': [{ name: 'md', template: 'markdown', content: { body: 'saved' } }] },
          content: {
            md: { body: '# Draft heading\n\n<script>alert("draft")</script><img src="/x.png" onerror="steal()">' },
          },
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<h1>Draft heading</h1>')
    expect(body).toContain('<img src="/x.png">')
    expect(body).not.toContain('alert("draft")')
    expect(body).not.toContain('steal()')
    expect(body).not.toContain('# Draft heading')
  })
})
