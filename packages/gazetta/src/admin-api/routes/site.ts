import { Hono } from 'hono'
import type { SourceContextResolver } from '../source-context.js'
import { loadSiteFromSource } from '../source-context.js'

export function siteRoutes(resolve: SourceContextResolver) {
  const app = new Hono()

  app.get('/api/site', async c => {
    const source = await resolve(c.req.query('target'))
    // Return the project-level manifest if available on the source context.
    if (source.manifest) return c.json(source.manifest)
    // Last resort: read from target content root.
    try {
      const site = await loadSiteFromSource(source)
      return c.json(site.manifest)
    } catch {
      return c.json({ name: '(empty)', targets: {} })
    }
  })

  return app
}
