/**
 * `gazetta targets [site]`: prints every target with the capabilities
 * view's rows, from the site's config (design-public-storage.md, UX check).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runTargets } from '../src/cli/targets.js'
import { loadSiteTargets } from '../src/cli/bootstrap.js'
import { tempDir } from './_helpers/temp.js'

const dir = tempDir(`cli-targets-${Date.now()}`)
afterAll(() => rm(dir, { recursive: true, force: true }))

async function siteWith(config: string): Promise<string> {
  const siteDir = join(dir, `site-${Math.random().toString(36).slice(2)}`)
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'site.config.ts'), config)
  return siteDir
}

describe('gazetta targets', () => {
  it('prints each target with its rows', async () => {
    const siteDir = await siteWith(`
import { defineSite, filesystemStorage } from 'gazetta'
export default defineSite({
  name: 'Test',
  targets: {
    local: { storage: filesystemStorage({ path: './dist/local' }), editable: true },
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      requiresPublishApproval: true,
      requiredPublishApprovers: 2,
    },
  },
})
`)
    const { targetConfigs } = await loadSiteTargets(siteDir)
    const lines: string[] = []
    runTargets({ targetConfigs, log: l => lines.push(l) })
    const out = lines.join('\n')

    const localAt = out.indexOf('  local\n')
    const stagingAt = out.indexOf('  staging\n')
    expect(localAt).toBeGreaterThanOrEqual(0)
    expect(stagingAt).toBeGreaterThan(localAt)
    const local = out.slice(localAt, stagingAt)
    const staging = out.slice(stagingAt)
    expect(local).toMatch(/Storage\s+Private \(editing folder\)/)
    expect(local).toMatch(/Audit\s+Kept here/)
    expect(staging).toMatch(/Storage\s+Public \(assumed\)/)
    expect(staging).toMatch(/History\s+Off: storage is public/)
    expect(staging).toMatch(/Audit\s+Kept on `local`/)
    expect(staging).toMatch(/Deploy\s+None/)
    expect(staging).toMatch(/Content review\s+Not available: storage is public/)
    expect(staging).toMatch(/Publish approval\s+Required, 2 approvers/)
    expect(local).toMatch(/Publish approval\s+Not required/)
  })
})
