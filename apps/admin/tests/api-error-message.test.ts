/**
 * The client's request() maps a non-OK admin-API response to an error.
 * Errors are RFC 9457 problem+json (design-agent-access.md Q45): the
 * message is `detail`, the stable code is `code`, and typed extras
 * (`issues`, `current`, `currentEtag`, `archive`) are extension members.
 *
 * Uses `vi.spyOn(global, 'fetch')` to mock the server response so
 * tests run without a real admin process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  ApiError,
  ArchivedNameConflictError,
  setActiveTargetProvider,
  StaleSaveError,
  ValidationFailedError,
} from '../src/client/api/client.js'

afterEach(() => {
  vi.restoreAllMocks()
  setActiveTargetProvider(null)
})

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(input, init))
}

const TITLES: Record<number, string> = { 409: 'Conflict', 500: 'Internal Server Error' }

function problemResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: TITLES[status], status, ...body }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
}

describe('request() error mapping from problem bodies', () => {
  it('surfaces detail and code for a 409 ARCHIVED save refusal', async () => {
    mockFetch(() => problemResponse(409, { code: 'ARCHIVED', detail: 'Archived. Restore to edit.' }))
    const err = await api.updatePage('home', { content: {} }).catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ message: 'Archived. Restore to edit.', code: 'ARCHIVED', status: 409 })
  })

  it('surfaces detail for a 409 EDIT_LOCKED save refusal', async () => {
    mockFetch(() => problemResponse(409, { code: 'EDIT_LOCKED', detail: 'Locked by a review session.' }))
    await expect(api.updateFragment('header', { content: {} })).rejects.toThrow('Locked by a review session.')
  })

  it('maps STALE to StaleSaveError with the current manifest and etag', async () => {
    mockFetch(() => problemResponse(409, { code: 'STALE', current: { template: 'hero' }, currentEtag: 'e2' }))
    const err = await api.updatePage('home', { content: {} }).catch(e => e)
    expect(err).toBeInstanceOf(StaleSaveError)
    expect(err).toMatchObject({ current: { template: 'hero' }, currentEtag: 'e2' })
  })

  it('maps VALIDATION_FAILED to ValidationFailedError with the issues', async () => {
    const issues = [{ validator: 'v', severity: 'error', message: 'Broken ref', itemPath: 'pages/home/page.json' }]
    mockFetch(() => problemResponse(409, { code: 'VALIDATION_FAILED', issues }))
    const err = await api.updatePage('home', { content: {} }).catch(e => e)
    expect(err).toBeInstanceOf(ValidationFailedError)
    expect(err.issues).toEqual(issues)
  })

  it('maps ARCHIVED_NAME_CONFLICT to ArchivedNameConflictError with the archive', async () => {
    const archive = { kind: 'page', name: 'about', archivedAt: '2026-11-01T00:00:00Z' }
    mockFetch(() => problemResponse(409, { code: 'ARCHIVED_NAME_CONFLICT', archive }))
    const err = await api.createPage({ name: 'about', template: 'page-default' }).catch(e => e)
    expect(err).toBeInstanceOf(ArchivedNameConflictError)
    expect(err.archive).toEqual(archive)
  })

  it('surfaces detail for a plain 500', async () => {
    mockFetch(() => problemResponse(500, { code: 'INTERNAL', detail: 'boom' }))
    await expect(api.updatePage('home', { content: {} })).rejects.toThrow('boom')
  })

  it('falls back to the status when the problem has no detail', async () => {
    mockFetch(() => problemResponse(409, { code: 'CONFLICT' }))
    await expect(api.updatePage('home', { content: {} })).rejects.toThrow('Request failed: 409')
  })

  it('falls back to the status text when the body is not JSON', async () => {
    mockFetch(() => new Response('gateway down', { status: 502, statusText: 'Bad Gateway' }))
    await expect(api.updatePage('home', { content: {} })).rejects.toThrow('Bad Gateway')
  })
})
