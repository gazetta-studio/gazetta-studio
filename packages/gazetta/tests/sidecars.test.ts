/**
 * Direct unit tests for sidecars.ts — the content-addressing I/O module.
 *
 * Closes the gap identified in testing-plan.md Priority 1.2: the module
 * has 60+ LOC of logic centralized from publish/compare/publish-rendered
 * but no dedicated test file. Tests use an in-memory StorageProvider
 * fake — same pattern as history-recorder.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readSidecars, writeSidecars, listSidecars, collectFragmentRefs, type SidecarState } from '../src/sidecars.js'
import { memoryStorage } from './_helpers/memory-storage.js'

describe('readSidecars', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('returns null for a missing directory', async () => {
    expect(await readSidecars(storage, 'pages/ghost')).toBeNull()
  })

  it('returns null for a directory with no .hash sidecar', async () => {
    // A directory with the page.json but no sidecars yet — pre-publish state.
    storage.seed({ 'pages/home/page.json': '{}' })
    expect(await readSidecars(storage, 'pages/home')).toBeNull()
  })

  it('returns hash-only state when only the .hash sidecar is present', async () => {
    storage.seed({
      'pages/home/page.json': '{}',
      'pages/home/.abcd1234.hash': '',
    })
    expect(await readSidecars(storage, 'pages/home')).toEqual({
      hash: 'abcd1234',
      pub: null,
    })
  })

  it('returns hash + pub state when both are present', async () => {
    storage.seed({
      'pages/home/page.json': '{}',
      'pages/home/.abcd1234.hash': '',
      'pages/home/.pub-20260417T220000Z': '',
    })
    const state = await readSidecars(storage, 'pages/home')
    expect(state?.hash).toBe('abcd1234')
    expect(state?.pub).toEqual({ lastPublished: '2026-04-17T22:00:00Z', noindex: false })
  })

  it('ignores unrelated files in the directory', async () => {
    storage.seed({
      'pages/home/page.json': '{}',
      'pages/home/.abcd1234.hash': '',
      'pages/home/index.html': '<html>…</html>',
      'pages/home/styles.foo.css': '.a{}',
    })
    expect(await readSidecars(storage, 'pages/home')).toEqual({
      hash: 'abcd1234',
      pub: null,
    })
  })
})

describe('writeSidecars', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('writes the .hash sidecar for a hash-only state', async () => {
    const state: SidecarState = { hash: 'deadbeef', pub: null }
    await writeSidecars(storage, 'pages/home', state)
    const files = [...storage.dump().keys()].filter(p => p.startsWith('pages/home/'))
    expect(files).toContain('pages/home/.deadbeef.hash')
    expect(files.some(f => f.includes('.uses-'))).toBe(false)
    expect(files.some(f => f.includes('.tpl-'))).toBe(false)
  })

  it('writes hash + pub sidecars when both are present in state', async () => {
    const state: SidecarState = {
      hash: 'deadbeef',
      pub: { lastPublished: '2026-04-17T22:00:00Z', noindex: true },
    }
    await writeSidecars(storage, 'pages/home', state)
    const files = [...storage.dump().keys()].filter(p => p.startsWith('pages/home/'))
    expect(files).toContain('pages/home/.deadbeef.hash')
    expect(files).toContain('pages/home/.pub-20260417T220000Z-noindex')
  })

  it('is idempotent — writing the same state twice leaves the same files', async () => {
    const state: SidecarState = { hash: 'aa11bb22', pub: null }
    await writeSidecars(storage, 'pages/home', state)
    const snap1 = new Set([...storage.dump().keys()])
    await writeSidecars(storage, 'pages/home', state)
    const snap2 = new Set([...storage.dump().keys()])
    expect(snap2).toEqual(snap1)
  })

  it('removes stale hash sidecar when hash changes', async () => {
    await writeSidecars(storage, 'pages/home', { hash: '11111111', pub: null })
    await writeSidecars(storage, 'pages/home', { hash: '22222222', pub: null })
    const files = [...storage.dump().keys()].filter(p => p.startsWith('pages/home/'))
    expect(files).toContain('pages/home/.22222222.hash')
    expect(files).not.toContain('pages/home/.11111111.hash')
  })

  it('leaves non-sidecar files alone (index.html, page.json, …)', async () => {
    storage.seed({
      'pages/home/page.json': '{}',
      'pages/home/index.html': '<html>',
      'pages/home/.01234567.hash': '', // an old sidecar — this SHOULD be removed
    })
    await writeSidecars(storage, 'pages/home', { hash: 'abcdef01', pub: null })
    const files = [...storage.dump().keys()].filter(p => p.startsWith('pages/home/'))
    expect(files).toContain('pages/home/page.json')
    expect(files).toContain('pages/home/index.html')
    expect(files).toContain('pages/home/.abcdef01.hash')
    // The old hash sidecar should be gone (stale sidecar cleanup)
    expect(files).not.toContain('pages/home/.01234567.hash')
  })
})

describe('writeSidecars — concurrency', () => {
  /**
   * Storage that simulates `write-file-atomic`'s observable temp file.
   * Each `writeFile(path, content)`:
   *   1. Creates `{path}.{nonce}` (temp — briefly visible via readDir)
   *   2. Yields to the microtask queue
   *   3. Deletes the temp, sets the final path
   *
   * Without this behavior, the in-memory storage in the base tests
   * commits instantly and can't reproduce the race. With it, two
   * concurrent `writeSidecars` calls can interleave readDir-then-rm
   * passes across each other's temp files — exactly the production
   * race this test guards against.
   */
  function racingMemoryStorage(): ReturnType<typeof memoryStorage> {
    const base = memoryStorage()
    let nonce = 0
    const originalWriteFile = base.writeFile
    base.writeFile = async (path, content) => {
      const tmp = `${path}.${++nonce}`
      await originalWriteFile.call(base, tmp, content)
      // Yield to let any concurrent readDir/rm observe the temp file.
      await new Promise(r => setImmediate(r))
      const tmpContent = base.dump().get(tmp)
      if (tmpContent === undefined) {
        // Someone else rm'd our temp while we were yielding — that's the
        // race this test exists to reject. Fail fast with the same shape
        // as production's ENOENT.
        throw new Error(`ENOENT: rename ${tmp} -> ${path}`)
      }
      await base.rm(tmp)
      await originalWriteFile.call(base, path, content)
    }
    return base
  }

  it('two concurrent writeSidecars on the same dir do not race each other', async () => {
    const storage = racingMemoryStorage()
    storage.seed({ 'pages/home/page.json': '{}' })

    const stateDefault: SidecarState = {
      hash: 'aaaaaaaa',
      pub: { lastPublished: '2026-04-23T22:00:00Z', noindex: false },
    }
    const stateFr: SidecarState = {
      hash: 'bbbbbbbb',
      pub: { lastPublished: '2026-04-23T22:00:00Z', noindex: false },
    }

    // Without the per-dir lock, call B's cleanup would observe call A's
    // in-flight temp files and delete them — A's final writeFile would
    // then throw "ENOENT: rename ...". The lock serializes them so B
    // only ever sees A's committed state.
    await Promise.all([
      writeSidecars(storage, 'pages/home', stateDefault),
      writeSidecars(storage, 'pages/home', stateFr, 'fr'),
    ])

    const files = [...storage.dump().keys()].filter(p => p.startsWith('pages/home/')).sort()
    expect(files).toContain('pages/home/.aaaaaaaa.hash')
    expect(files).toContain('pages/home/.bbbbbbbb.hash.fr')
    expect(files.some(f => /\.\d+$/.test(f))).toBe(false)
  })

  it('serialization is per-directory — different dirs run in parallel', async () => {
    const storage = racingMemoryStorage()
    storage.seed({
      'pages/home/page.json': '{}',
      'pages/about/page.json': '{}',
    })

    await Promise.all([
      writeSidecars(storage, 'pages/home', { hash: 'aaaaaaaa', pub: null }),
      writeSidecars(storage, 'pages/about', { hash: 'bbbbbbbb', pub: null }),
    ])

    const keys = [...storage.dump().keys()]
    expect(keys).toContain('pages/home/.aaaaaaaa.hash')
    expect(keys).toContain('pages/about/.bbbbbbbb.hash')
  })

  it('four locale variants of the same page publish cleanly (reproduces CI failure)', async () => {
    // Regression test for the CI e2e failure:
    //   "Cannot write .../dist/staging/pages/home/.<hash>.hash:
    //    ENOENT ... rename '<tmp>' -> '<final>'"
    // With 4 locales racing, the probability of the unlocked code
    // tripping the race approaches 1.
    const storage = racingMemoryStorage()
    storage.seed({ 'pages/home/page.json': '{}' })

    const pub = { lastPublished: '2026-04-23T22:00:00Z', noindex: false }

    await Promise.all([
      writeSidecars(storage, 'pages/home', { hash: '11111111', pub }),
      writeSidecars(storage, 'pages/home', { hash: '22222222', pub }, 'fr'),
      writeSidecars(storage, 'pages/home', { hash: '33333333', pub }, 'ar'),
      writeSidecars(storage, 'pages/home', { hash: '44444444', pub }, 'ja'),
    ])

    const files = [...storage.dump().keys()].filter(p => p.startsWith('pages/home/')).sort()
    expect(files).toContain('pages/home/.11111111.hash')
    expect(files).toContain('pages/home/.22222222.hash.fr')
    expect(files).toContain('pages/home/.33333333.hash.ar')
    expect(files).toContain('pages/home/.44444444.hash.ja')
  })
})

describe('listSidecars', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('returns an empty map when the root directory does not exist', async () => {
    expect(await listSidecars(storage, 'does/not/exist')).toEqual(new Map())
  })

  it('collects sidecars from every sub-directory keyed by relative path', async () => {
    storage.seed({
      'pages/home/page.json': '{}',
      'pages/home/.aaaaaaaa.hash': '',
      'pages/about/page.json': '{}',
      'pages/about/.bbbbbbbb.hash': '',
    })
    const out = await listSidecars(storage, 'pages')
    expect(out.size).toBe(2)
    expect(out.get('home')?.hash).toBe('aaaaaaaa')
    expect(out.get('about')?.hash).toBe('bbbbbbbb')
  })

  it('skips sub-directories without a .hash sidecar', async () => {
    storage.seed({
      'pages/home/.aaaaaaaa.hash': '',
      'pages/home/page.json': '{}',
      // pages/new exists (has a page.json) but no .hash sidecar → not in map
      'pages/new/page.json': '{}',
    })
    const out = await listSidecars(storage, 'pages')
    expect(out.size).toBe(1)
    expect(out.has('home')).toBe(true)
    expect(out.has('new')).toBe(false)
  })

  it('recurses into nested sub-directories (e.g. blog/[slug])', async () => {
    storage.seed({
      'pages/blog/[slug]/page.json': '{}',
      'pages/blog/[slug]/.aaaaaaaa.hash': '',
    })
    const out = await listSidecars(storage, 'pages')
    expect(out.has('blog/[slug]')).toBe(true)
    expect(out.get('blog/[slug]')?.hash).toBe('aaaaaaaa')
  })
})

describe('collectFragmentRefs', () => {
  it('returns empty for undefined or empty input', () => {
    expect(collectFragmentRefs(undefined)).toEqual([])
    expect(collectFragmentRefs([])).toEqual([])
  })

  it('collects top-level @fragment refs', () => {
    expect(collectFragmentRefs(['@header', '@footer'])).toEqual(['header', 'footer'])
  })

  it('ignores non-@ strings and inline components without fragment refs', () => {
    expect(collectFragmentRefs(['@header', { name: 'hero', template: 'hero' }, 'not-a-fragment'])).toEqual(['header'])
  })

  it("recurses into inline components' nested components", () => {
    expect(
      collectFragmentRefs([
        {
          name: 'layout',
          template: 'layout',
          components: ['@nav', { name: 'sidebar', template: 'sidebar', components: ['@widgets'] }],
        },
      ]).sort(),
    ).toEqual(['nav', 'widgets'])
  })

  it('deduplicates repeated fragment references', () => {
    expect(
      collectFragmentRefs(['@header', { name: 'section', template: 's', components: ['@header', '@footer'] }]).sort(),
    ).toEqual(['footer', 'header'])
  })
})
