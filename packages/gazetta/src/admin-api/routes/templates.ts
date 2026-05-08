import { Hono } from 'hono'
import { join } from 'node:path'
import { z } from 'zod'
import { loadTemplate, hasEditorFile } from '../../template-loader.js'
import { createFilesystemProvider } from '../../providers/filesystem.js'
import type { SourceContextResolver } from '../source-context.js'
import { loadSiteFromSource } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import type { ValidationScanner } from '../../validation/scanner.js'
import { computeTemplateImpact } from '../../validation/template-impact.js'

const EDITOR_EXTENSIONS = ['.tsx', '.ts']

export interface TemplateRoutesOptions {
  /**
   * Validation scanner — used by `GET /api/templates/:name/impact` to
   * project the template's per-item issues. When omitted, the impact
   * endpoint reports all clean (no issues), which matches the
   * "validation disabled" boot path.
   */
  scanner?: ValidationScanner | null
}

export function templateRoutes(
  resolve: SourceContextResolver,
  templatesDir?: string,
  adminDir?: string,
  production?: boolean,
  opts: TemplateRoutesOptions = {},
) {
  const app = new Hono()
  // Templates and admin live at project level, outside target content storage.
  // Read them via a cwd-rooted filesystem provider and absolute paths.
  const storage = createFilesystemProvider()

  async function dirs(c: import('hono').Context) {
    const source = await resolve(c.req.query('target'))
    const { projectSiteDir } = source
    const tplDir = templatesDir ?? join(projectSiteDir, 'templates')
    const admDir = adminDir ?? join(projectSiteDir, 'admin')
    const editorsDir = join(admDir, 'editors')
    const fieldsDir = join(admDir, 'fields')
    // In dev mode, Vite serves source files via /@fs/ URLs
    const fieldsBaseUrl = production ? '/admin/fields' : `/admin/@fs/${fieldsDir}`
    return { tplDir, editorsDir, fieldsBaseUrl }
  }

  app.get('/api/templates', requireCapability('read:pages'), async c => {
    const { tplDir } = await dirs(c)
    if (!(await storage.exists(tplDir))) return c.json([])

    const entries = await storage.readDir(tplDir)
    const templates = entries.filter(e => e.isDirectory).map(e => ({ name: e.name }))
    return c.json(templates)
  })

  app.get('/api/templates/:name/schema', requireCapability('read:pages'), async c => {
    const name = c.req.param('name')
    const { tplDir, editorsDir, fieldsBaseUrl } = await dirs(c)

    try {
      const loaded = await loadTemplate(storage, tplDir, name)
      const jsonSchema = z.toJSONSchema(loaded.schema as z.ZodType)
      const hasEditor = await hasEditorFile(storage, editorsDir, name)

      let editorUrl: string | undefined
      if (hasEditor) {
        if (production) {
          // Production — pre-bundled JS
          editorUrl = `/admin/editors/${name}.js`
        } else {
          // Dev mode — Vite /@fs/ serving
          for (const ext of EDITOR_EXTENSIONS) {
            const filePath = join(editorsDir, `${name}${ext}`)
            if (await storage.exists(filePath)) {
              editorUrl = `/admin/@fs/${filePath}`
              break
            }
          }
        }
      }

      return c.json({ ...(jsonSchema as Record<string, unknown>), hasEditor, editorUrl, fieldsBaseUrl })
    } catch (err) {
      return c.json({ error: `Failed to load schema for template "${name}": ${(err as Error).message}` }, 500)
    }
  })

  /**
   * GET /api/templates/:name/impact — Validation Cut 6.
   *
   * Returns the items (pages + fragments) that use this template, along
   * with their issues from the background scanner. Powers the
   * DevPlayground "Impact" tab + the toolbar banner's view-impact link.
   *
   * The walk recurses into nested inline components (a page that doesn't
   * top-level-use the template but contains a deep inline component
   * with that template still appears in the impact list — its
   * schema-conformance issues land on the item).
   *
   * `scanner` is optional. When validation is disabled (or not yet
   * built at boot), every item appears with `issues: []` — accurate
   * since no validation ran.
   */
  app.get('/api/templates/:name/impact', requireCapability('read:pages'), async c => {
    const name = c.req.param('name')
    const source = await resolve(c.req.query('target'))
    let site: import('../../site-loader.js').Site
    try {
      site = await loadSiteFromSource(source)
    } catch (err) {
      return c.json({ error: `Failed to load site: ${(err as Error).message}` }, 500)
    }
    const issuesFor = (path: string) => opts.scanner?.issuesFor(path) ?? []
    const impact = computeTemplateImpact(site, name, issuesFor)
    return c.json(impact)
  })

  return app
}
