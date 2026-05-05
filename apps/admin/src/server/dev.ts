/// <reference types="node" />
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { buildSourceContext } from 'gazetta'
import { createAdminApp } from './index.js'

const siteDir = resolve(process.argv[2] ?? '../../examples/starter')
const port = parseInt(process.env.API_PORT ?? '4000', 10)

// Resolve the default editable target from site.config.ts and derive a
// SourceContext pointing at its content. Cloud targets are not initialized
// here — the admin API does lazy init on first publish/fetch/compare.
const { source, manifest, targetConfigs } = await buildSourceContext({ projectSiteDir: siteDir })

const app = createAdminApp({
  source,
  siteDir, // used for templatesDir/adminDir defaults
  targetConfigs,
})

serve({ fetch: app.fetch, port }, () => {
  console.log(`\n  Gazetta Admin API running at http://localhost:${port}`)
  console.log(`  Site: ${manifest.name} (${siteDir})`)
  if (targetConfigs && Object.keys(targetConfigs).length > 0) {
    console.log(`  Targets: ${Object.keys(targetConfigs).join(', ')} (editable sources init'd; others lazy)`)
  }
  console.log()
})
