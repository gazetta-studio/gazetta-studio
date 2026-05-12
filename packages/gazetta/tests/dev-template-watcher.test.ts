import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isTemplateEventRecent } from '../src/cli/dev-template-watcher'
import { tempDir } from './_helpers/temp'

// Issue #286: spurious fs.watch events fire for template files whose mtime
// predates the watcher's start time — typically after a worker-scoped
// `cp -r` in e2e setup, when the kernel flushes delayed metadata for files
// the watcher didn't originally observe. Each such event triggers
// notifyReload(), which sends an SSE message that calls location.reload()
// in the admin UI, closing any open publish-panel mid-test.
//
// The watcher classifier suppresses events for files whose mtime is older
// than the recent-change window — real edits update mtime to ~now and pass
// the gate; stale flush events for old-mtime files do not.
describe('isTemplateEventRecent', () => {
  let root: string
  beforeEach(async () => {
    root = tempDir(`dev-template-watcher-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(root, { recursive: true })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('returns true for a file whose mtime is inside the recent window', async () => {
    const path = join(root, 'hero.ts')
    await writeFile(path, 'export default {}')
    // writeFile sets mtime to ~now, well within any reasonable window
    expect(await isTemplateEventRecent(path, 1000)).toBe(true)
  })

  test('returns false for a file whose mtime predates the recent window (#286)', async () => {
    const path = join(root, 'hero.ts')
    await writeFile(path, 'export default {}')
    // Backdate mtime to 5 seconds ago — outside any 1s recent window.
    // Models the cp-r case: bytes were written in setup, the watcher
    // registered later, and a delayed inotify metadata event arrives
    // for the file with its old write-time mtime intact.
    const oldSeconds = (Date.now() - 5000) / 1000
    await utimes(path, oldSeconds, oldSeconds)
    expect(await isTemplateEventRecent(path, 1000)).toBe(false)
  })

  test('returns true for a non-existent file (deleted between event and stat)', async () => {
    // If stat fails the file was removed/renamed; treat as a real change
    // so deletion/rename of a template still triggers a reload.
    expect(await isTemplateEventRecent(join(root, 'never-existed.ts'), 1000)).toBe(true)
  })

  test('respects a wider recent window when mtime sits just inside it', async () => {
    const path = join(root, 'hero.ts')
    await writeFile(path, 'export default {}')
    const twoSecondsAgoSeconds = (Date.now() - 2000) / 1000
    await utimes(path, twoSecondsAgoSeconds, twoSecondsAgoSeconds)
    // Outside 1s, inside 5s — caller's window choice decides the verdict
    expect(await isTemplateEventRecent(path, 1000)).toBe(false)
    expect(await isTemplateEventRecent(path, 5000)).toBe(true)
  })
})
