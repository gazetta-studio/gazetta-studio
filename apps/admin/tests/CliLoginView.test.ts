/**
 * The CLI sign-in page (design-agent-access.md Q19, Q21): loads the login,
 * shows its details, and sends Approve or Deny.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import CliLoginView from '../src/client/components/CliLoginView.vue'

const pending = {
  code: 'ABCD-EFGH',
  machine: 'alice-macbook',
  ip: '203.0.113.7',
  startedAt: '2026-11-01T09:30:00Z',
  expiresAt: '2999-01-01T00:00:00Z',
  state: 'pending',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const problem = (status: number, code: string, detail: string) =>
  new Response(JSON.stringify({ status, code, detail }), {
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
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/cli-login/:code', component: CliLoginView }],
  })
  await router.push('/cli-login/ABCD-EFGH')
  await router.isReady()
  const wrapper = mount(CliLoginView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

const byId = (id: string) => `[data-testid="${id}"]`
const calledUrl = (i: number) => String(fetchMock.mock.calls[i][0])

describe('CliLoginView', () => {
  it('shows the details of a pending login', async () => {
    fetchMock.mockResolvedValueOnce(json(pending))
    const w = await render()
    expect(calledUrl(0)).toContain('/auth/logins/ABCD-EFGH')
    expect(w.find(byId('cli-login-code')).text()).toBe('ABCD-EFGH')
    expect(w.find(byId('cli-login-machine')).text()).toBe('alice-macbook')
    expect(w.find(byId('cli-login-ip')).text()).toBe('203.0.113.7')
    expect(w.find(byId('cli-login-started')).text()).toBe(new Date(pending.startedAt).toLocaleString())
    expect(w.find(byId('cli-login-warning')).text()).toContain('Only approve a code you started yourself.')
  })

  it('leaves out the IP row when there is no IP address', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...pending, ip: undefined }))
    const w = await render()
    expect(w.find(byId('cli-login-ip')).exists()).toBe(false)
  })

  it.each([
    ['approve', 'cli-login-approve', 'approved', 'Approved. You can go back to your terminal.'],
    ['deny', 'cli-login-deny', 'denied', "Denied. The command line won't be signed in."],
  ])('%s posts the decision and shows the result', async (decision, button, state, message) => {
    fetchMock.mockResolvedValueOnce(json(pending)).mockResolvedValueOnce(json({ state }))
    const w = await render()
    await w.find(byId(button)).trigger('click')
    await flushPromises()
    expect(calledUrl(1)).toContain(`/auth/logins/ABCD-EFGH/${decision}`)
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' })
    expect(w.find(byId(`cli-login-${state}`)).text()).toBe(message)
  })

  it('disables both buttons while the decision is being sent', async () => {
    let answer!: (r: Response) => void
    fetchMock.mockResolvedValueOnce(json(pending)).mockReturnValueOnce(new Promise<Response>(r => (answer = r)))
    const w = await render()
    await w.find(byId('cli-login-approve')).trigger('click')
    expect(w.find(byId('cli-login-approve')).attributes('disabled')).toBeDefined()
    expect(w.find(byId('cli-login-deny')).attributes('disabled')).toBeDefined()
    answer(json({ state: 'approved' }))
    await flushPromises()
    expect(w.find(byId('cli-login-approved')).exists()).toBe(true)
  })

  it('shows expired when approving answers 410', async () => {
    fetchMock.mockResolvedValueOnce(json(pending)).mockResolvedValueOnce(problem(410, 'LOGIN_EXPIRED', 'Expired'))
    const w = await render()
    await w.find(byId('cli-login-approve')).trigger('click')
    await flushPromises()
    expect(w.find(byId('cli-login-expired')).exists()).toBe(true)
  })

  it('shows expired when the login has already expired on load', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...pending, expiresAt: '2000-01-01T00:00:00Z' }))
    const w = await render()
    expect(w.find(byId('cli-login-expired')).exists()).toBe(true)
    expect(w.find(byId('cli-login-approve')).exists()).toBe(false)
  })

  it('shows the decision when the login was already decided', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...pending, state: 'denied' }))
    const w = await render()
    expect(w.find(byId('cli-login-denied')).exists()).toBe(true)
  })

  it('reads the decision back when deciding answers 409', async () => {
    fetchMock
      .mockResolvedValueOnce(json(pending))
      .mockResolvedValueOnce(problem(409, 'CONFLICT', 'Already decided'))
      .mockResolvedValueOnce(json({ ...pending, state: 'approved' }))
    const w = await render()
    await w.find(byId('cli-login-deny')).trigger('click')
    await flushPromises()
    expect(w.find(byId('cli-login-approved')).exists()).toBe(true)
  })

  it('shows not found on 404', async () => {
    fetchMock.mockResolvedValueOnce(problem(404, 'NOT_FOUND', 'No such login'))
    const w = await render()
    expect(w.find(byId('cli-login-not-found')).exists()).toBe(true)
  })

  it("shows the problem's detail on other errors", async () => {
    fetchMock.mockResolvedValueOnce(problem(403, 'BROWSER_REQUIRED', 'Approve this sign-in from a browser.'))
    const w = await render()
    expect(w.find(byId('cli-login-error')).text()).toBe(
      "Couldn't load this sign-in: Approve this sign-in from a browser.",
    )
  })
})
