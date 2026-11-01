/**
 * `GET /api/version` — the API majors this admin serves
 * (design-agent-access.md Q43).
 *
 * Mounted outside the versioned prefix, so a client can ask before it
 * knows which major to use. The exact `gazetta` version goes only to a
 * signed-in caller.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoute } from '@hono/zod-openapi'
import { isAnonymous, type PrincipalEnv } from '../middleware/principal.js'
import { API_MAJORS, apiApp, json } from '../openapi.js'
import { type VersionResponse, VersionResponseSchema } from '../schemas/version.js'

const getVersion = createRoute({
  method: 'get',
  path: '/api/version',
  summary: 'The API majors this admin serves',
  description:
    'Outside the versioned prefix, so a client can ask before it picks a major. `version` is the exact gazetta version, sent only to a signed-in caller.',
  responses: { 200: json(VersionResponseSchema, 'The supported majors') },
})

/** The `gazetta` package's version, read once (`src/` and `dist/` sit at the same depth). */
let packageVersion: string | undefined
function gazettaVersion(): string {
  if (packageVersion === undefined) {
    const pkg = resolve(import.meta.dirname, '../../../package.json')
    packageVersion = existsSync(pkg)
      ? (JSON.parse(readFileSync(pkg, 'utf-8')) as { version: string }).version
      : 'unknown'
  }
  return packageVersion
}

export function versionRoutes() {
  const app = apiApp<PrincipalEnv>()

  app.openapi(getVersion, c => {
    const body: VersionResponse = { majors: [...API_MAJORS] }
    if (!isAnonymous(c.var.principal)) body.version = gazettaVersion()
    return c.json(body, 200)
  })

  return app
}
