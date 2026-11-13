/**
 * GET /api/v1/validation/issues: the response body. The `read:pages`
 * gate is covered in auth-route-gates.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { ValidationScanner } from '../src/validation/scanner.js'
import type { Issue } from '../src/validation/types.js'
import { fakeScanner } from './_helpers/fake-scanner.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function build(scanner?: ValidationScanner) {
  const storage = memoryStorage()
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'validation-site' },
  })
  return createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    disableCacheStatsLogger: true,
    ...(scanner ? { validationScanner: scanner } : {}),
  })
}

const issues: Issue[] = [
  {
    validator: 'referenced-fragment-exists',
    severity: 'error',
    message: 'Fragment @nav does not exist',
    itemPath: 'pages/home/page.json',
    contentPath: 'components.0',
  },
  { validator: 'unused-fragment', severity: 'info', message: 'Not used', itemPath: 'fragments/promo/fragment.json' },
]

describe('GET /api/v1/validation/issues', () => {
  it("returns the scanner's issues with their item paths, validators and severities", async () => {
    const res = await build(fakeScanner(issues)).request('/api/v1/validation/issues')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issues, total: 2 })
  })

  it('returns an empty list when no scanner is configured', async () => {
    const res = await build().request('/api/v1/validation/issues')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issues: [], total: 0 })
  })
})
