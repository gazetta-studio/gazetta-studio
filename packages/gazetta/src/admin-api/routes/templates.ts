import { Hono } from 'hono'
import { join } from 'node:path'
import { z } from 'zod'
import { loadTemplate, hasEditorFile } from '../../template-loader.js'
import { createFilesystemProvider } from '../../providers/filesystem.js'
import type { SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'

const EDITOR_EXTENSIONS = ['.tsx', '.ts']

export function templateRoutes(
  resolve: SourceContextResolver,
  templatesDir?: string,
  adminDir?: string,
  production?: boolean,
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

  return app
}
