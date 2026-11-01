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

  it('marks a login page as a login', async () => {
    fetchMock.mockResolvedValueOnce(json(pending))
    const w = await render()
    expect(w.find(byId('cli-login')).attributes('data-kind')).toBe('login')
    expect(w.find('h1').text()).toBe('Approve a sign-in from the command line')
  })
})

describe('CliLoginView for an elevation', () => {
  const elevation = { ...pending, kind: 'elevation', scope: 'production' }
  const future = '2999-01-01T12:00:00Z'
  const until = new Date(future).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  it('shows the production heading and the elevation warning', async () => {
    fetchMock.mockResolvedValueOnce(json(elevation))
    const w = await render()
    expect(w.find(byId('cli-login')).attributes('data-kind')).toBe('elevation')
    expect(w.find('h1').text()).toBe('Allow alice-macbook to publish to production for a short time')
    expect(w.find(byId('cli-login-machine')).text()).toBe('alice-macbook')
    expect(w.find(byId('cli-login-warning')).text()).toBe(
      'Only approve a code you started yourself. Approving lets that machine publish as you until it ends.',
    )
  })

  it('shows the non-production heading', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...elevation, scope: 'non-production' }))
    const w = await render()
    expect(w.find('h1').text()).toBe(
      'Allow alice-macbook to publish, delete and restore on non-production targets for a short time',
    )
  })

  it('shows until when it runs after Approve, with End now', async () => {
    fetchMock
      .mockResolvedValueOnce(json(elevation))
      .mockResolvedValueOnce(json({ state: 'approved', elevationId: 'elv_1', endsAt: future }))
    const w = await render()
    await w.find(byId('cli-login-approve')).trigger('click')
    await flushPromises()
    expect(w.find(byId('cli-login-elevation-active')).text()).toBe(
      `Approved. alice-macbook can publish until ${until}.`,
    )
    expect(w.find(byId('cli-login-end-elevation')).exists()).toBe(true)
  })

  it('End now deletes the elevation and shows it ended', async () => {
    let answer!: (r: Response) => void
    fetchMock
      .mockResolvedValueOnce(json({ ...elevation, state: 'approved', elevationId: 'elv_1', endsAt: future }))
      .mockReturnValueOnce(new Promise<Response>(r => (answer = r)))
    const w = await render()
    await w.find(byId('cli-login-end-elevation')).trigger('click')
    expect(calledUrl(1)).toContain('/auth/elevations/elv_1')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' })
    expect(w.find(byId('cli-login-end-elevation')).attributes('disabled')).toBeDefined()
    answer(new Response(null, { status: 204 }))
    await flushPromises()
    expect(w.find(byId('cli-login-elevation-ended')).text()).toBe('Ended. alice-macbook can only edit again.')
  })

  it('counts an elevation already gone (404) as ended', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ...elevation, state: 'approved', elevationId: 'elv_1', endsAt: future }))
      .mockResolvedValueOnce(problem(404, 'NOT_FOUND', 'No such elevation'))
    const w = await render()
    await w.find(byId('cli-login-end-elevation')).trigger('click')
    await flushPromises()
    expect(w.find(byId('cli-login-elevation-ended')).exists()).toBe(true)
  })

  it('shows ended when the elevation has already ended on load', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ ...elevation, state: 'approved', elevationId: 'elv_1', endsAt: '2000-01-01T00:00:00Z' }),
    )
    const w = await render()
    expect(w.find(byId('cli-login-elevation-ended')).exists()).toBe(true)
    expect(w.find(byId('cli-login-end-elevation')).exists()).toBe(false)
  })

  it("shows the refusal's detail when approving answers 403", async () => {
    fetchMock
      .mockResolvedValueOnce(json(elevation))
      .mockResolvedValueOnce(problem(403, 'FORBIDDEN', 'Your role can’t publish to production.'))
    const w = await render()
    await w.find(byId('cli-login-approve')).trigger('click')
    await flushPromises()
    expect(w.find(byId('cli-login-error')).text()).toContain('Your role can’t publish to production.')
  })

  it('names publishing when an elevation is denied', async () => {
    fetchMock.mockResolvedValueOnce(json(elevation)).mockResolvedValueOnce(json({ state: 'denied' }))
    const w = await render()
    await w.find(byId('cli-login-deny')).trigger('click')
    await flushPromises()
    expect(w.find(byId('cli-login-denied')).text()).toBe("Denied. The command line won't be able to publish as you.")
  })
})
