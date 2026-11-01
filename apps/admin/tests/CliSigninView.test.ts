/**
 * "Sign in a command line" (design-agent-access.md Q15, Q23): shows the gz
 * command, a shared Cloudflare service token when the operator set one, and
 * behind ALB creates a grant to paste, shown once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CliSigninView from '../src/client/components/CliSigninView.vue'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ status, code, detail: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

async function render() {
  const wrapper = mount(CliSigninView)
  await flushPromises()
  return wrapper
}
const byId = (id: string) => `[data-testid="${id}"]`

describe('CliSigninView', () => {
  it('shows the command to run when the code is approved in the browser', async () => {
    fetchMock.mockResolvedValueOnce(json({ trustMode: 'forwarded-user', paste: false }))
    const w = await render()
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/v1\/auth\/cli-setup$/)
    expect(w.find(byId('cli-signin-command')).text()).toBe(`gz auth login ${window.location.origin}`)
    expect(w.find(byId('cli-signin-paste')).exists()).toBe(false)
    expect(w.find(byId('cli-signin-cloudflare')).exists()).toBe(false)
  })

  it('shows a shared Cloudflare service token to copy', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        trustMode: 'cloudflare-access',
        paste: false,
        cloudflare: { clientId: 'abc.access', clientSecret: 's3cret' },
      }),
    )
    const w = await render()
    expect(w.find(byId('cli-signin-cloudflare')).text()).toContain('abc.access')
    expect(w.find(byId('cli-signin-cloudflare')).text()).toContain('s3cret')
  })

  it('behind ALB, creates a grant for the named machine and shows its secret once', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ trustMode: 'aws-cognito', paste: true }))
      .mockResolvedValueOnce(json({ grantId: 'g-1', grantSecret: 'g-1.s3cret' }, 201))
    const w = await render()
    expect(w.find(byId('cli-signin-command')).text()).toBe(`gz auth login ${window.location.origin} --paste`)
    expect(w.find(byId('cli-signin-create')).attributes('disabled')).toBeDefined()
    await w.find(byId('cli-signin-machine')).setValue('build-server')
    await w.find(byId('cli-signin-create')).trigger('click')
    await flushPromises()
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/auth\/grants$/)
    expect(JSON.parse(String(init.body))).toEqual({ machine: 'build-server' })
    expect(w.find(byId('cli-signin-secret')).text()).toBe('g-1.s3cret')
    expect(w.find(byId('cli-signin-paste')).exists()).toBe(false)
    expect(w.find(byId('cli-signin-copy-secret')).exists()).toBe(true)
  })

  it('asks a person who is not signed in to sign in first', async () => {
    fetchMock.mockResolvedValueOnce(problem(401, 'UNAUTHENTICATED'))
    const w = await render()
    expect(w.find(byId('cli-signin-signed-out')).exists()).toBe(true)
  })
})
