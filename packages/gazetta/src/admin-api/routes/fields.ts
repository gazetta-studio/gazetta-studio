import { Hono } from 'hono'
import { join } from 'node:path'
import { createFilesystemProvider } from '../../providers/filesystem.js'
import type { SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'

const FIELD_EXTENSIONS = ['.ts', '.tsx']

export function fieldRoutes(resolve: SourceContextResolver, adminDir?: string) {
  const app = new Hono()
  // Custom fields live at project level, outside target content storage.
  const storage = createFilesystemProvider()

  app.get('/api/fields', requireCapability('read:pages'), async c => {
    // projectSiteDir is target-invariant (it's the on-disk project path).
    // We still go through resolve() so the single source-lookup codepath
    // serves this route too — keeps the handler shape uniform.
    const source = await resolve(c.req.query('target'))
    const fieldsDir = join(adminDir ?? join(source.projectSiteDir, 'admin'), 'fields')

    if (!(await storage.exists(fieldsDir))) return c.json([])

    const entries = await storage.readDir(fieldsDir)
    const fields = entries
      .filter(e => !e.isDirectory && FIELD_EXTENSIONS.some(ext => e.name.endsWith(ext)))
      .map(e => {
        const name = e.name.replace(/\.(ts|tsx)$/, '')
        return { name, path: join(fieldsDir, e.name) }
      })
    return c.json(fields)
  })

  return app
}
