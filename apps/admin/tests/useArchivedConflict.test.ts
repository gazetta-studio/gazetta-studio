/**
 * useArchivedConflict — composable extracted from CreatePageDialog /
 * CreateFragmentDialog / CreateRedirectDialog at the rule-15 3-caller
 * threshold (#486). Owns the archived-name-conflict morph state +
 * resolution wiring; consumers supply the kind-specific POST attempt
 * + the success side effects.
 *
 * Tests pin two surfaces:
 *
 *   1. Runtime behavior of the composable (catches
 *      ArchivedNameConflictError, sets `conflict` ref, `handleResolve`
 *      re-issues with `onConflict`, `handleConflictCancel` resets,
 *      busy flag tracks the in-flight attempt) — these are the
 *      runtime branches the compiler can't enforce.
 *
 *   2. Structural invariant: all three Create*Dialog components
 *      import `useArchivedConflict`. A future Create dialog touching
 *      the same conflict surface must consume the composable, not
 *      reimplement the catch+morph wiring inline. The compiler
 *      doesn't catch this — a dialog could drop the import and add
 *      its own `ref<ArchivedNameConflictDetails | null>` shadow copy
 *      without any build failure.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ArchivedNameConflictError } from '../src/client/api/client.js'
import { useArchivedConflict } from '../src/client/composables/useArchivedConflict.js'

const ARCHIVE = {
  kind: 'page' as const,
  name: 'old-page',
  archivedAt: '2026-05-01T00:00:00Z',
}

describe('useArchivedConflict — initial state', () => {
  it('exposes null conflict, null error, and idle busy', () => {
    const handle = useArchivedConflict({
      attempt: vi.fn().mockResolvedValue(undefined),
    })
    expect(handle.conflict.value).toBeNull()
    expect(handle.error.value).toBeNull()
    expect(handle.busy.value).toBe(false)
  })
})

describe('useArchivedConflict — happy-path attempt', () => {
  it('invokes attempt(undefined) and onSuccess; busy returns to false', async () => {
    const attempt = vi.fn().mockResolvedValue(undefined)
    const onSuccess = vi.fn().mockResolvedValue(undefined)
    const handle = useArchivedConflict({ attempt, onSuccess })

    await handle.run()

    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(undefined)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(handle.conflict.value).toBeNull()
    expect(handle.error.value).toBeNull()
    expect(handle.busy.value).toBe(false)
  })

  it('does not require onSuccess', async () => {
    const attempt = vi.fn().mockResolvedValue(undefined)
    const handle = useArchivedConflict({ attempt })

    await handle.run()

    expect(attempt).toHaveBeenCalledTimes(1)
    expect(handle.busy.value).toBe(false)
  })

  it('sets busy to true during the attempt', async () => {
    let busyDuringAttempt = false
    const attempt = vi.fn().mockImplementation(async () => {
      busyDuringAttempt = handle.busy.value
    })
    const handle = useArchivedConflict({ attempt })

    await handle.run()

    expect(busyDuringAttempt).toBe(true)
    expect(handle.busy.value).toBe(false)
  })
})

describe('useArchivedConflict — archived-name conflict path', () => {
  it('catches ArchivedNameConflictError and sets the conflict ref', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new ArchivedNameConflictError(ARCHIVE))
    const onSuccess = vi.fn()
    const handle = useArchivedConflict({ attempt, onSuccess })

    await handle.run()

    expect(handle.conflict.value).toEqual(ARCHIVE)
    expect(handle.error.value).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(handle.busy.value).toBe(false)
  })
})

describe('useArchivedConflict — non-archive error path', () => {
  it('records the error message and leaves conflict null', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('LIVE_NAME_CONFLICT'))
    const onSuccess = vi.fn()
    const handle = useArchivedConflict({ attempt, onSuccess })

    await handle.run()

    expect(handle.conflict.value).toBeNull()
    expect(handle.error.value).toBe('LIVE_NAME_CONFLICT')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(handle.busy.value).toBe(false)
  })
})

describe('useArchivedConflict — handleResolve re-issues with onConflict', () => {
  it.each(['restore', 'replace', 'moveAside'] as const)('forwards mode=%s to attempt()', async mode => {
    const attempt = vi.fn().mockResolvedValue(undefined)
    const onSuccess = vi.fn()
    const handle = useArchivedConflict({ attempt, onSuccess })

    await handle.handleResolve(mode)

    expect(attempt).toHaveBeenCalledWith({ onConflict: mode })
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('handleResolve preserves catch handling — archive error sets conflict, not error', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new ArchivedNameConflictError(ARCHIVE))
    const handle = useArchivedConflict({ attempt })

    await handle.handleResolve('replace')

    expect(handle.conflict.value).toEqual(ARCHIVE)
    expect(handle.error.value).toBeNull()
  })
})

describe('useArchivedConflict — handleConflictCancel', () => {
  it('clears conflict and error refs', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new ArchivedNameConflictError(ARCHIVE))
    const handle = useArchivedConflict({ attempt })

    await handle.run()
    expect(handle.conflict.value).not.toBeNull()

    handle.handleConflictCancel()
    expect(handle.conflict.value).toBeNull()
    expect(handle.error.value).toBeNull()
  })

  it('clears a previous error message even when no conflict was set', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('boom'))
    const handle = useArchivedConflict({ attempt })

    await handle.run()
    expect(handle.error.value).toBe('boom')

    handle.handleConflictCancel()
    expect(handle.error.value).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Structural invariant — all three Create*Dialog components consume the
// composable. Prevents the regression where a future dialog reimplements
// the inline catch + morph wiring instead of going through the seam.
// ---------------------------------------------------------------------------

const DIALOG_PATHS = [
  'apps/admin/src/client/components/CreatePageDialog.vue',
  'apps/admin/src/client/components/CreateFragmentDialog.vue',
  'apps/admin/src/client/components/CreateRedirectDialog.vue',
]

const REPO_ROOT = join(__dirname, '..', '..', '..')

describe('useArchivedConflict — structural invariant', () => {
  it.each(DIALOG_PATHS)('%s imports useArchivedConflict', relativePath => {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8')
    expect(source).toMatch(/from\s+['"][^'"]*useArchivedConflict[^'"]*['"]/)
  })
})
