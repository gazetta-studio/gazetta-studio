/**
 * Pins the retry contract on `rmSafe` — the shared e2e teardown helper.
 *
 * Why this exists: the e2e fixture's dev server keeps writing reverse-dep
 * sidecars (`.gazetta/fragment-deps/{frag}/{src}`, `.gazetta/asset-refs/...`)
 * while scenarios call `rm` to wipe target dirs between tests. Without
 * `maxRetries` on `fs.rm`, the rm walk's `rmdir` races against a new file
 * appearing in the directory and throws `ENOTEMPTY` (issue #494).
 *
 * Node's `fs.rm` retries on ENOTEMPTY/EBUSY/EMFILE/EPERM internally when
 * `maxRetries > 0`. This test asserts `rmSafe` opts into that — a future
 * refactor that drops the option would re-introduce the flake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    rm: vi.fn().mockResolvedValue(undefined),
  }
})

import { rm } from 'node:fs/promises'
import { rmSafe } from '../../../tests/e2e/_helpers/rm-safe.js'

describe('rmSafe — e2e teardown helper', () => {
  beforeEach(() => {
    vi.mocked(rm).mockClear()
  })

  it('passes maxRetries >= 1 to fs.rm so ENOTEMPTY races with the dev server retry', async () => {
    await rmSafe('/tmp/some-path')

    expect(rm).toHaveBeenCalledTimes(1)
    const [path, opts] = vi.mocked(rm).mock.calls[0]
    expect(path).toBe('/tmp/some-path')
    expect(opts).toMatchObject({ recursive: true, force: true })

    const typed = opts as { maxRetries?: number; retryDelay?: number }
    expect(typed.maxRetries ?? 0).toBeGreaterThanOrEqual(1)
    expect(typed.retryDelay ?? 0).toBeGreaterThanOrEqual(50)
  })
})
