/** #1334: an item's hash includes the assets it uses, read from every manifest file of each asset. */
import { describe, expect, it } from 'vitest'
import { computeAssetHashes } from '../src/asset-hashes.js'
import { createContentRoot } from '../src/content-root.js'
import { hashManifest } from '../src/hash.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const page = (asset?: string) => ({
  template: 'page',
  route: '/x',
  components: [{ name: 'hero', template: 'hero', content: asset ? { image: { _asset: asset } } : { title: 'x' } }],
})

describe('computeAssetHashes', () => {
  async function setup() {
    const storage = memoryStorage()
    await storage.writeFile('assets/hero.asset.json', '{"name":"hero","alt":"a"}')
    await storage.writeFile('assets/products/shot.asset.json', '{"name":"products/shot"}')
    await storage.writeFile('assets/heroic.asset.json', '{"name":"heroic"}')
    return { storage, root: createContentRoot(storage, '') }
  }

  it('changes when the default or a language version of the asset changes', async () => {
    const { storage, root } = await setup()
    const first = (await computeAssetHashes(root, ['hero'])).get('hero')
    await storage.writeFile('assets/hero.asset.fr.json', '{"name":"hero","alt":"fr"}')
    const withFr = (await computeAssetHashes(root, ['hero'])).get('hero')
    await storage.writeFile('assets/hero.asset.json', '{"name":"hero","alt":"b"}')
    const edited = (await computeAssetHashes(root, ['hero'])).get('hero')
    expect(new Set([first, withFr, edited]).size).toBe(3)
  })

  it("ignores other assets' files, finds assets in folders, and leaves missing assets out", async () => {
    const { storage, root } = await setup()
    const before = await computeAssetHashes(root, ['hero', 'products/shot', 'gone'])
    await storage.writeFile('assets/heroic.asset.json', '{"name":"heroic","alt":"changed"}')
    const after = await computeAssetHashes(root, ['hero', 'products/shot', 'gone'])
    expect(after.get('hero')).toBe(before.get('hero'))
    expect(after.get('products/shot')).toMatch(/^[0-9a-f]{8}$/)
    expect(after.has('gone')).toBe(false)
  })
})

describe('hashManifest with asset hashes', () => {
  const opts = (hash: string) => ({ templateHashes: new Map(), assetHashes: new Map([['hero', hash]]) })

  it.each([
    ['an item that uses the asset changes', page('hero'), false],
    ["an item that doesn't keeps its hash", page(), true],
  ])('%s', (_, manifest, same) => {
    expect(hashManifest(manifest, opts('aaaaaaaa')) === hashManifest(manifest, opts('bbbbbbbb'))).toBe(same)
  })

  it('leaves items without asset references hashing as before', () => {
    expect(hashManifest(page(), opts('aaaaaaaa'))).toBe(hashManifest(page(), { templateHashes: new Map() }))
  })
})
