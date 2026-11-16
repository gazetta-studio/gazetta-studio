/**
 * `cloudflare-redirects-limit`: Cloudflare Pages reads at most 2,000
 * static `_redirects` rows (design-redirects.md "Cloudflare Pages
 * limits", #1149). A target with `redirects.format: 'cloudflare'` whose
 * file would pass that gets one warning, counting the rows publish would
 * actually write: one per archive with an alias, per language the
 * target publishes.
 *
 * At `cli` every cloudflare target is checked. At `pre-publish` only the
 * destination being audited is, since the publish audit runs once per
 * destination and a strict one promotes warnings to errors.
 */
import { describe, expect, it } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { loadSite } from '../src/site-loader.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { runPublishAudit } from '../src/validation/publish-audit.js'
import { cloudflareRedirectsLimit } from '../src/validation/validators/cloudflare-redirects-limit.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const LOCALES = { default: 'en', supported: ['en', 'fr', 'ar', 'ja'] }

/** `aliased` archived pages with an alias and `gone` without one; rows = aliased × 4 languages. */
async function siteWith(opts: { aliased: number; gone?: number; targets: Record<string, Partial<TargetConfig>> }) {
  const storage = memoryStorage()
  const seed: Record<string, string> = {
    'pages/home/page.json': JSON.stringify({ template: 'echo' }),
  }
  for (let i = 0; i < opts.aliased; i++) {
    seed[`pages/old-${i}/page.json`] = JSON.stringify({ template: 'echo', archived: true, aliasOf: 'home' })
  }
  for (let i = 0; i < (opts.gone ?? 0); i++) {
    seed[`pages/gone-${i}/page.json`] = JSON.stringify({ template: 'echo', archived: true })
  }
  storage.seed(seed)
  const manifest = { name: 'test', locales: LOCALES, targets: opts.targets } as unknown as SiteManifest
  const site = await loadSite({ contentRoot: createContentRoot(storage), manifest })
  return { site, storage }
}

function cliRun(site: Awaited<ReturnType<typeof siteWith>>['site']) {
  return cloudflareRedirectsLimit.validate({
    stage: 'cli',
    site,
    contentRoot: site.contentRoot,
    storage: site.storage,
    scope: { kind: 'cli' },
  })
}

const cloudflareTarget = { type: 'static', redirects: { format: 'cloudflare' } } as Partial<TargetConfig>

describe('cloudflare-redirects-limit', () => {
  it('warns once, naming the target and the row count, past 2,000 rows', async () => {
    const { site } = await siteWith({ aliased: 501, targets: { production: cloudflareTarget } })
    const issues = await cliRun(site)
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warn')
    expect(issues[0].message).toContain('"production"')
    expect(issues[0].message).toContain('2,004')
    expect(issues[0].message).toContain('2,000')
  })

  it('stays quiet at exactly 2,000 rows', async () => {
    const { site } = await siteWith({ aliased: 500, targets: { production: cloudflareTarget } })
    expect(await cliRun(site)).toEqual([])
  })

  it("doesn't count archives without an alias, which write no row", async () => {
    const { site } = await siteWith({ aliased: 500, gone: 100, targets: { production: cloudflareTarget } })
    expect(await cliRun(site)).toEqual([])
  })

  it('ignores targets with another format', async () => {
    const { site } = await siteWith({
      aliased: 501,
      targets: {
        netlify: { type: 'static', redirects: { format: 'netlify' } } as Partial<TargetConfig>,
        json: { type: 'static', redirects: { format: 'json' } } as Partial<TargetConfig>,
      },
    })
    expect(await cliRun(site)).toEqual([])
  })

  it('counts only the languages the target publishes', async () => {
    const { site } = await siteWith({
      aliased: 1001,
      targets: { production: { ...cloudflareTarget, locales: ['en', 'fr'] } as Partial<TargetConfig> },
    })
    const issues = await cliRun(site)
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('2,002')
  })

  describe('in the publish audit', () => {
    const registry = createValidatorRegistry([cloudflareRedirectsLimit])

    async function audit(target: string, strict: boolean) {
      const { site, storage } = await siteWith({
        aliased: 501,
        targets: {
          production: cloudflareTarget,
          staging: { type: 'static', publishAudit: { strict: true } } as Partial<TargetConfig>,
        },
      })
      return runPublishAudit({
        items: [{ kind: 'page', name: 'home' }],
        site,
        contentRoot: site.contentRoot,
        storage,
        registry,
        strict,
        target,
      })
    }

    it('warns when publishing to the cloudflare target past the limit', async () => {
      const issues = await audit('production', false)
      expect(issues).toHaveLength(1)
      expect(issues[0].severity).toBe('warn')
    })

    it('says nothing when publishing to another target, even a strict one', async () => {
      expect(await audit('staging', true)).toEqual([])
    })
  })
})
