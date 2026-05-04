import { Hono } from 'hono'
import type { StorageProvider } from './types.js'
import { loadSite } from './site-loader.js'
import { resolvePage } from './resolver.js'
import { renderPage } from './renderer.js'

export async function createApp(siteDir: string, storage: StorageProvider): Promise<Hono> {
  const app = new Hono()
  const site = await loadSite({ siteDir, storage, manifest: { name: '(app)' } })

  for (const [pageName, page] of site.pages) {
    app.get(page.route, async c => {
      const resolved = await resolvePage(pageName, site)
      const html = await renderPage(resolved, c.req.param())
      return c.html(html)
    })
  }

  return app
}
