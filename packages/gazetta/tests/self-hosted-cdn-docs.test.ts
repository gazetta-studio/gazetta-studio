/**
 * #1205: a CDN in front of `gazetta serve` keeps serving the old page for
 * up to `cache.edge` after a publish. Gazetta can purge only Cloudflare
 * (`PurgeConfig.type`), so the self-hosting docs must say how to clear it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const doc = readFileSync(resolve(here, '../../../docs/self-hosted.md'), 'utf-8')

function cdnSection(): string {
  const section = doc.split('\n### ').find(s => s.startsWith('Behind a CDN'))
  if (!section) throw new Error('docs/self-hosted.md has no "Behind a CDN" section')
  return section.split('\n## ')[0]
}

describe('docs/self-hosted.md "Behind a CDN" (#1205)', () => {
  it('says pages stay stale for up to cache.edge and how to clear them', () => {
    const section = cdnSection()
    expect(section).not.toMatch(/No special configuration needed/)
    expect(section).toContain('`cache.edge`')
    expect(section).toContain('`cache.purge`')
  })
})
