/**
 * Build-smoke test for the Cut 11 service worker.
 *
 * Runtime SW behavior (precache hit on offline cold load,
 * skipWaiting on update) is e2e territory — needs a real browser
 * with network throttling. THIS test validates the build wiring:
 *
 *   - `vite build` produces dist/sw.js
 *   - sw.js contains a non-empty precache manifest with the app
 *     shell entries (index.html, vendor chunks, CSS)
 *   - sw.js wires the SKIP_WAITING listener so the update toast
 *     can activate the new SW
 *   - sw.js calls clientsClaim() so the new SW takes over open tabs
 *   - sw.js calls cleanupOutdatedCaches() so prior versions don't
 *     leak storage
 *
 * The build runs in `beforeAll` once for the whole file. Output is
 * read directly from `dist/`. We don't tear down dist/ — concurrent
 * test files don't interfere with these assertions.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const adminRoot = resolve(import.meta.dirname, '..')
const swPath = resolve(adminRoot, 'dist/sw.js')

describe('service worker build', () => {
  let sw: string

  beforeAll(() => {
    // Skip if dist/sw.js was already built (CI may pre-build).
    // Otherwise run vite build to produce it.
    if (!existsSync(swPath)) {
      execSync('npx vite build', { cwd: adminRoot, stdio: 'pipe' })
    }
    sw = readFileSync(swPath, 'utf-8')
  }, 120_000) // build can take 30-60s on cold cache

  it('produces dist/sw.js', () => {
    expect(existsSync(swPath)).toBe(true)
    expect(sw.length).toBeGreaterThan(1000)
  })

  it('precaches the app shell (index.html + vendor chunks + CSS)', () => {
    // The precache manifest is bundled inline as an array of
    // `{ revision, url }` entries. Smoke-check that the shell files
    // are listed.
    expect(sw).toMatch(/index\.html/)
    expect(sw).toMatch(/vendor-vue/)
    expect(sw).toMatch(/vendor-primevue/)
    expect(sw).toMatch(/\.css/)
  })

  it('wires SKIP_WAITING handler for the update toast handshake', () => {
    expect(sw).toContain('SKIP_WAITING')
    expect(sw).toContain('skipWaiting')
  })

  it('calls clientsClaim so the new SW controls open tabs', () => {
    // workbox-core's clientsClaim minifies but the activate-and-claim
    // signature stays recognizable.
    expect(sw).toContain('clients.claim')
  })

  it('calls cleanupOutdatedCaches to drop prior-version storage', () => {
    // workbox-precaching's cleanupOutdatedCaches generates a cache-
    // keys-walk; the `-precache-` suffix is the stable marker.
    expect(sw).toContain('-precache-')
  })
})
