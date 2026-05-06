/**
 * Pin the save-concurrency etag contract per `design-offline.md` Q3.
 *
 * This module's primary load-bearing property is **client+server
 * parity** — both sides call computeSaveEtag and MUST produce
 * identical output. The browser-side test (in apps/admin/tests)
 * imports the same function via 'gazetta/save-etag' and runs the
 * same fixtures; if either drifts, both fail.
 */
import { describe, it, expect } from 'vitest'
import { computeSaveEtag } from '../src/save-etag.js'

describe('computeSaveEtag', () => {
  it('produces a 16-char lowercase hex string', async () => {
    const etag = await computeSaveEtag({ template: 'hero', content: { title: 'Hi' } })
    expect(etag).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic — same input → same etag', async () => {
    const a = await computeSaveEtag({ template: 'hero', content: { title: 'Hi' } })
    const b = await computeSaveEtag({ template: 'hero', content: { title: 'Hi' } })
    expect(a).toBe(b)
  })

  it('changes when content changes', async () => {
    const a = await computeSaveEtag({ template: 'hero', content: { title: 'Hi' } })
    const b = await computeSaveEtag({ template: 'hero', content: { title: 'Hello' } })
    expect(a).not.toBe(b)
  })

  it('changes when template changes', async () => {
    const a = await computeSaveEtag({ template: 'hero', content: { title: 'Hi' } })
    const b = await computeSaveEtag({ template: 'banner', content: { title: 'Hi' } })
    expect(a).not.toBe(b)
  })

  it('changes when components change', async () => {
    const a = await computeSaveEtag({ template: 'page', components: ['hero'] })
    const b = await computeSaveEtag({ template: 'page', components: ['hero', 'footer'] })
    expect(a).not.toBe(b)
  })

  it('changes when route changes (page-only field)', async () => {
    const a = await computeSaveEtag({ template: 'page', route: '/old' })
    const b = await computeSaveEtag({ template: 'page', route: '/new' })
    expect(a).not.toBe(b)
  })

  it('changes when metadata changes (page-only field)', async () => {
    const a = await computeSaveEtag({ template: 'page', metadata: { title: 'A' } })
    const b = await computeSaveEtag({ template: 'page', metadata: { title: 'B' } })
    expect(a).not.toBe(b)
  })

  it('is invariant to non-save fields (sidecars, derived state)', async () => {
    // The save etag covers manifest fields the save endpoint writes.
    // Other fields (sidecars, locales array, dir, etc.) are NOT part
    // of the save concurrency check — adding/removing them does not
    // dirty the etag.
    const a = await computeSaveEtag({ template: 'hero', content: { title: 'Hi' } })
    const b = await computeSaveEtag({
      template: 'hero',
      content: { title: 'Hi' },
      // None of these fields are part of SAVE_ETAG_FIELDS:
      dir: '/some/path',
      locales: ['en', 'fr'],
      hash: 'abc12345',
    })
    expect(a).toBe(b)
  })

  it('is invariant to JSON key ordering', async () => {
    // Sorted-key canonicalization — different insertion order of the
    // same logical content produces the same etag.
    const a = await computeSaveEtag({
      template: 'hero',
      content: { title: 'Hi', subtitle: 'Yo' },
    })
    const b = await computeSaveEtag({
      content: { subtitle: 'Yo', title: 'Hi' },
      template: 'hero',
    })
    expect(a).toBe(b)
  })

  it('treats absent fields and explicit undefined the same way', async () => {
    // JSON.stringify drops undefined; an absent field and an explicit
    // undefined produce identical canonical JSON.
    const a = await computeSaveEtag({ template: 'hero', content: { title: 'Hi' } })
    const b = await computeSaveEtag({ template: 'hero', content: { title: 'Hi' }, metadata: undefined })
    expect(a).toBe(b)
  })

  it('treats null and absent differently (intentional)', async () => {
    // JSON.stringify keeps null. Explicit null is a meaningful value
    // (e.g., "this field is intentionally cleared"); the etag MUST
    // reflect that distinction.
    const a = await computeSaveEtag({ template: 'hero', content: null })
    const b = await computeSaveEtag({ template: 'hero' })
    expect(a).not.toBe(b)
  })

  it('handles deeply-nested content', async () => {
    const etag = await computeSaveEtag({
      template: 'page',
      content: {
        hero: { title: 'A', meta: { tags: ['x', 'y'] } },
        sections: [{ id: 1, body: { text: 'one' } }],
      },
    })
    expect(etag).toMatch(/^[0-9a-f]{16}$/)
  })
})
