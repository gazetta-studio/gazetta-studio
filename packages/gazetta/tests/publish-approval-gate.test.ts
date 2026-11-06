/**
 * The publish-approval gate at step 0 of publishToTarget (review workflow
 * cut 12, #1787; design-review-workflow.md locks 1, 5, 6 and "How the gate
 * meets the shared publish function"). A target without
 * `requiresPublishApproval` publishes as before; a gated one refuses
 * without a signed-in user, refuses removals, and otherwise gets one
 * request per page or fragment item on the source while nothing is
 * written to the target.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { expandRole, type Principal } from '../src/auth/index.js'
import { createContentRoot } from '../src/content-root.js'
import {
  GatedRemovalError,
  PublishApprovalRequiredError,
  PublishRequestForbiddenError,
} from '../src/publish-approval-gate.js'
import { createPublishSnapshot, type PublishSnapshot } from '../src/publish-snapshot.js'
import { publishToTarget, type PublishToTargetInput } from '../src/publish-target.js'
import { readPublishRequest, type PublishRequestRecord } from '../src/review/publish-requests.js'
import { scanTemplates, type TemplateInfo } from '../src/templates-scan.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterProjectRoot, starterTemplatesDir } from './_helpers/starter.js'

const page = (components: unknown[], title = 'Home') =>
  JSON.stringify({ template: 'page-default', metadata: { title }, components })
const fragment = (components: unknown[] = []) => JSON.stringify({ template: 'header-layout', components })

const SOURCE = {
  'pages/home/page.json': page(['@header', '@promo', { name: 'msg', template: 'text-block', content: { body: 'Hi' } }]),
  'pages/home/page.fr.json': page(['@header'], 'Accueil'),
  'pages/about/page.json': page(['@header'], 'About'),
  'pages/about/page.fr.json': page(['@header'], 'À propos'),
  'fragments/header/fragment.json': fragment(['@logo']),
  'fragments/logo/fragment.json': fragment(),
  'fragments/promo/fragment.json': fragment(),
}

const manifest: SiteManifest = {
  name: 'gate-test',
  locales: { default: 'en', supported: ['en', 'fr'] },
} as SiteManifest

const editor = (capabilities = expandRole('editor') ?? []): Principal => ({
  id: 'alice',
  role: 'editor',
  trustMode: 'forwarded-user',
  capabilities,
})

let templateInfos: TemplateInfo[]

beforeAll(async () => {
  templateInfos = await scanTemplates(starterTemplatesDir, starterProjectRoot)
})

describe('publishApprovalGate in publishToTarget', { timeout: 30000 }, () => {
  let source: MemoryStorage
  let target: MemoryStorage
  let snapshot: PublishSnapshot

  beforeEach(async () => {
    source = memoryStorage()
    source.seed(SOURCE)
    target = memoryStorage()
    snapshot = await createPublishSnapshot({
      contentRoot: createContentRoot(source, ''),
      manifest,
      templatesDir: starterTemplatesDir,
    })
  })

  const gated = (extra: Partial<TargetConfig> = {}): TargetConfig =>
    ({
      type: 'esi',
      environment: 'production',
      publicStorage: false,
      requiresPublishApproval: true,
      ...extra,
    }) as TargetConfig

  const publish = (targetConfig: TargetConfig, over: Partial<PublishToTargetInput> = {}) =>
    publishToTarget({
      targetName: 'production',
      targetStorage: target,
      targetConfig,
      snapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: ['pages/home'],
      itemRefs: [{ kind: 'page', name: 'home' }],
      templateInfos,
      purgeScope: 'all',
      ...over,
    })

  const requestsOnSource = () => [...source.dump().keys()].filter(k => k.startsWith('.gazetta/publish-requests/'))

  const readRequest = async (r: PublishRequestRecord) =>
    readPublishRequest(createContentRoot(source, ''), r.target, r.kind, r.name, r.id)

  it('publishes a target without requiresPublishApproval as before', async () => {
    const result = await publish({ ...gated(), requiresPublishApproval: false }, { requester: editor() })
    expect(result.outcome).toBe('published')
    expect(result.requests).toEqual([])
    expect(await target.exists('pages/home/page.json')).toBe(true)
    expect(requestsOnSource()).toEqual([])
  })

  it('refuses a gated target without a signed-in user and writes nothing', async () => {
    await expect(publish(gated())).rejects.toThrow(PublishApprovalRequiredError)
    await expect(publish(gated())).rejects.toThrow('production requires publish approval — request it from the admin.')
    expect(target.dump().size).toBe(0)
    expect(requestsOnSource()).toEqual([])
  })

  it('refuses a user without publish:request and writes nothing', async () => {
    await expect(publish(gated(), { requester: editor(['read:*', 'edit:*']) })).rejects.toThrow(
      PublishRequestForbiddenError,
    )
    expect(target.dump().size).toBe(0)
    expect(requestsOnSource()).toEqual([])
  })

  it('refuses removals on a gated target before any write', async () => {
    await expect(publish(gated(), { requester: editor(), removals: [{ kind: 'page', name: 'old' }] })).rejects.toThrow(
      GatedRemovalError,
    )
    expect(target.dump().size).toBe(0)
    expect(requestsOnSource()).toEqual([])
  })

  it('creates one request per page or fragment item and writes nothing to the target', async () => {
    const result = await publish(gated({ requiredPublishApprovers: 2 }), {
      requester: editor(),
      items: ['pages/home', 'pages/about:fr', 'fragments/header', 'templates/page-default'],
    })

    expect(result.outcome).toBe('requested')
    expect(result.run).toBeUndefined()
    expect(target.dump().size).toBe(0)
    expect(result.requests.map(r => r.item)).toEqual(['pages/home', 'pages/about:fr', 'fragments/header'])
    expect(new Set(result.requests.map(r => r.id)).size).toBe(3)

    const home = result.requests[0]
    expect(await readRequest(home)).toEqual(home)
    expect(home).toMatchObject({
      target: 'production',
      kind: 'page',
      name: 'home',
      source: 'local',
      requestedBy: 'alice',
      requiredPublishApprovers: 2,
      state: 'publish-pending',
    })
    // A bare page covers its translations: one hash per manifest it copies.
    expect(Object.keys(home.hashes).sort()).toEqual(['pages/home/page.fr.json', 'pages/home/page.json'])
    for (const h of Object.values(home.hashes)) expect(h).toMatch(/^[0-9a-f]{8}$/)
    // A translation published alone is its own request with its one manifest.
    expect(Object.keys(result.requests[1].hashes)).toEqual(['pages/about/page.fr.json'])

    const pending = requestsOnSource().filter(k => k.includes('/pending/'))
    expect(pending.sort()).toEqual(
      [
        `.gazetta/publish-requests/production/pending/fragments.header@${result.requests[2].id}`,
        `.gazetta/publish-requests/production/pending/pages.about:fr@${result.requests[1].id}`,
        `.gazetta/publish-requests/production/pending/pages.home@${home.id}`,
      ].sort(),
    )
  })

  it('snapshots requiredPublishApprovers as 1 when the target leaves it unset', async () => {
    const result = await publish(gated(), { requester: editor() })
    expect(result.requests[0].requiredPublishApprovers).toBe(1)
  })

  it('records the requests of new fragments a page uses, on an ESI target', async () => {
    // header (and logo) are already on the target; promo is new.
    target.seed({ 'fragments/header/.ab12cd34.hash': '', 'fragments/logo/.cd34ab12.hash': '' })
    const result = await publish(gated(), {
      requester: editor(),
      items: ['pages/home', 'pages/about', 'fragments/header', 'fragments/logo', 'fragments/promo'],
    })
    const byItem = new Map(result.requests.map(r => [r.item, r]))
    expect(byItem.get('pages/home')!.waitsFor).toEqual([byItem.get('fragments/promo')!.id])
    expect(byItem.get('pages/about')!.waitsFor).toEqual([])
    expect(byItem.get('fragments/promo')!.waitsFor).toEqual([])
  })

  it('also records changed fragments on a static target, through the fragments they use', async () => {
    // header is on the target unchanged; logo differs; promo isn't there.
    target.seed({
      'fragments/header/fragment.json': SOURCE['fragments/header/fragment.json'],
      'fragments/logo/fragment.json': fragment(['@promo']),
    })
    const result = await publish(gated({ type: 'static' }), {
      requester: editor(),
      items: ['pages/about', 'fragments/header', 'fragments/logo', 'fragments/promo'],
    })
    const byItem = new Map(result.requests.map(r => [r.item, r]))
    // about uses header, and logo through it.
    expect(byItem.get('pages/about')!.waitsFor).toEqual([byItem.get('fragments/logo')!.id])
  })
})
