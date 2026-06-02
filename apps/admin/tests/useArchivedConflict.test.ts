/**
 * useArchivedConflict — composable extracted from CreatePageDialog /
 * CreateFragmentDialog / CreateRedirectDialog at the rule-15 3-caller
 * threshold (#486). Owns the archived-name-conflict morph state +
 * resolution wiring; consumers supply the kind-specific POST attempt
 * + the success side effects.
 *
 * Tests pin the runtime behavior of the composable (catches
 * ArchivedNameConflictError, sets `conflict` ref, `handleResolve`
 * re-issues with `onConflict`, `handleConflictCancel` resets, busy
 * flag tracks the in-flight attempt) — the runtime branches the
 * compiler can't enforce. The three dialogs consuming it are the
 * production diff's proof of the extraction (#486); re-asserting that
 * via source-text regex is rule-41 proof-of-work, so it's not pinned
 * here.
 */
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
