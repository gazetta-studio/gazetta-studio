/** #1632: a publish reads the source's manifests once (design-publish-undo.md Q4). */
import { describe, expect, it } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { createPublishSnapshot } from '../src/publish-snapshot.js'
import type { SiteManifest } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

const manifest: SiteManifest = { name: 't', targets: {} }
const home = {
  template: 'page-default',
  components: [{ name: 'hero', template: 'hero', content: { image: { _asset: 'sky' } } }],
}
const homeFr = { ...home, components: [{ name: 'hero', template: 'hero', content: { image: { _asset: 'mer' } } }] }

function source() {
  const storage = memoryStorage()
  storage.seed({
    // `unlisted` isn't a field the site loader keeps; the snapshot keeps the raw text.
    'pages/home/page.json': JSON.stringify({ ...home, unlisted: 1 }),
    'pages/home/page.fr.json': JSON.stringify(homeFr),
    'pages/home/notes.txt': 'not a manifest',
    'assets/sky.asset.json': JSON.stringify({
      name: 'sky',
      kind: 'embedded',
      mime: 'image/png',
      hash: 'aaaaaaaa',
      alt: 'Sky',
    }),
    'assets/sky.asset.fr.json': JSON.stringify({ name: 'sky', alt: 'Ciel' }),
    'assets/mer.asset.json': JSON.stringify({ name: 'mer', kind: 'embedded', mime: 'image/png', hash: 'bbbbbbbb' }),
  })
  return storage
}
const snapshotOf = (storage: ReturnType<typeof memoryStorage>) =>
  createPublishSnapshot({ contentRoot: createContentRoot(storage, ''), manifest, templatesDir: starterTemplatesDir })

describe('createPublishSnapshot', () => {
  it('keeps the raw text of every manifest, fields the loader drops included', async () => {
    const snap = await snapshotOf(source())
    const read = (p: string) => snap.sourceRoot.storage.readFile(p)
    expect(JSON.parse(await read('pages/home/page.json')).unlisted).toBe(1)
    expect(JSON.parse(await read('pages/home/page.fr.json')).components[0].content.image._asset).toBe('mer')
    expect(JSON.parse(await read('assets/sky.asset.fr.json')).alt).toBe('Ciel')
    expect([...snap.assets].sort()).toEqual(['mer', 'sky'])
  })

  it("doesn't see writes made after it was taken", async () => {
    const storage = source()
    const snap = await snapshotOf(storage)
    storage.seed({
      'pages/home/page.json': JSON.stringify({ ...home, unlisted: 2 }),
      'pages/home/page.de.json': JSON.stringify(home),
      'assets/sky.asset.json': JSON.stringify({ name: 'sky', kind: 'embedded', mime: 'image/png', hash: 'cccccccc' }),
    })
    await storage.rm('pages/home/page.fr.json')
    const s = snap.sourceRoot.storage
    expect(JSON.parse(await s.readFile('pages/home/page.json')).unlisted).toBe(1)
    expect(await s.exists('pages/home/page.fr.json')).toBe(true)
    expect(await s.exists('pages/home/page.de.json')).toBe(false)
    await expect(s.readFile('pages/home/page.de.json')).rejects.toThrow()
    expect((await s.readDir('pages/home')).map(e => e.name).sort()).toEqual(['notes.txt', 'page.fr.json', 'page.json'])
    expect(JSON.parse(await s.readFile('assets/sky.asset.json')).hash).toBe('aaaaaaaa')
  })

  it('reads files that aren’t manifests from the live source', async () => {
    const storage = source()
    const snap = await snapshotOf(storage)
    storage.seed({ 'pages/home/notes.txt': 'edited' })
    expect(await snap.sourceRoot.storage.readFile('pages/home/notes.txt')).toBe('edited')
  })
})
