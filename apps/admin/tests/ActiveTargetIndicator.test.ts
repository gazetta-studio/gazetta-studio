/**
 * Component tests for ActiveTargetIndicator.vue.
 *
 * Scope: pure-render surface — visibility, env chrome, read-only badge,
 * interactivity gating, menu item shape. The full switchTo flow (unsaved
 * guard + missing-item toast) requires api.* to be injectable into the
 * component; that refactor is deferred (see testing-plan.md Priority 1.1
 * follow-up).
 *
 * Uses real Pinia + a real vue-router memory instance. PrimeVue is
 * registered globally so the Menu component resolves. HistoryPanel is
 * stubbed — its internals aren't the subject here.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, type ComponentMountingOptions } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import { createRouter, createMemoryHistory } from 'vue-router'
import ActiveTargetIndicator from '../src/client/components/ActiveTargetIndicator.vue'
import { useActiveTargetStore } from '../src/client/stores/activeTarget.js'
import type { TargetInfo } from '../src/client/api/client.js'

function setup(targets: TargetInfo[], active: string | null) {
  const active$ = useActiveTargetStore()
  active$.configure({
    loadTargets: async () => targets,
  })
  active$.targets = targets
  active$.activeTargetName = active
  return { active$ }
}

function mountWithGlobals(options?: ComponentMountingOptions<typeof ActiveTargetIndicator>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  return mount(ActiveTargetIndicator, {
    global: {
      plugins: [PrimeVue, router],
      stubs: { HistoryPanel: true, AuditDrawer: true },
      ...options?.global,
    },
    ...options,
  })
}

describe('ActiveTargetIndicator', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('visibility', () => {
    it('hides entirely when there are no targets', () => {
      setup([], null)
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').exists()).toBe(false)
    })

    it('hides when no active target is set', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, null)
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').exists()).toBe(false)
    })

    it('shows the pill with 1 target and active set', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').exists()).toBe(true)
      expect(w.find('[data-testid="active-target-indicator"]').text()).toContain('local')
    })
  })

  describe('environment chrome', () => {
    it('applies env-local for local environment', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').classes()).toContain('env-local')
    })

    it('applies env-staging for staging environment', () => {
      const targets: TargetInfo[] = [
        {
          name: 'staging',
          environment: 'staging',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'staging')
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').classes()).toContain('env-staging')
    })

    it('applies env-production for production environment', () => {
      const targets: TargetInfo[] = [
        {
          name: 'prod',
          environment: 'production',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'prod')
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').classes()).toContain('env-production')
    })

    it('falls back to env-local when environment is unset', () => {
      const targets: TargetInfo[] = [
        {
          name: 'unset',
          environment: undefined,
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'unset')
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').classes()).toContain('env-local')
    })
  })

  describe('editable vs read-only', () => {
    it('shows the read-only badge for non-editable targets', () => {
      const targets: TargetInfo[] = [
        {
          name: 'prod',
          environment: 'production',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'prod')
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').text()).toContain('read-only')
    })

    it('omits the read-only badge for editable targets', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').text()).not.toContain('read-only')
    })

    it('reflects editable in the title attribute', () => {
      const targetsRO: TargetInfo[] = [
        {
          name: 'prod',
          environment: 'production',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
      ]
      setup(targetsRO, 'prod')
      const w = mountWithGlobals()
      expect(w.find('[data-testid="active-target-indicator"]').attributes('title')).toContain('read-only')
    })
  })

  describe('interactivity', () => {
    it('marks the pill interactive with ≥1 target', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      const pill = w.find('[data-testid="active-target-indicator"]')
      expect(pill.classes()).toContain('interactive')
      expect(pill.attributes('aria-haspopup')).toBe('menu')
    })

    it('shows a chevron when interactive', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
        {
          name: 'staging',
          environment: 'staging',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      expect(w.find('.chevron').exists()).toBe(true)
    })

    it('renders the switcher Menu component when interactive', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
        {
          name: 'staging',
          environment: 'staging',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      // PrimeVue Menu teleports its popup; the root hosting element is
      // enough to verify it was instantiated.
      expect(w.findComponent({ name: 'Menu' }).exists()).toBe(true)
    })
  })

  describe('switcher menu items', () => {
    it('flat list when ≤3 targets', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
        {
          name: 'staging',
          environment: 'staging',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
        {
          name: 'prod',
          environment: 'production',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      const menu = w.findComponent({ name: 'Menu' })
      const model = menu.props('model') as Array<{ label?: string; separator?: boolean; items?: unknown[] }>
      // First N entries (before the separator) are the target items.
      const sepIdx = model.findIndex(m => m.separator)
      const targetLabels = model.slice(0, sepIdx).map(m => m.label)
      expect(targetLabels).toEqual(['local', 'staging', 'prod'])
    })

    it('groups same-environment targets at 4+ total', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
        {
          name: 'staging',
          environment: 'staging',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
        {
          name: 'prod-us',
          environment: 'production',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
        {
          name: 'prod-eu',
          environment: 'production',
          type: 'static',
          editable: false,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      const menu = w.findComponent({ name: 'Menu' })
      const model = menu.props('model') as Array<{
        label?: string
        separator?: boolean
        items?: Array<{ label: string }>
      }>
      const prodGroup = model.find(m => m.label === 'production' && m.items)
      expect(prodGroup).toBeDefined()
      expect(prodGroup!.items!.map(i => i.label)).toEqual(['prod-us', 'prod-eu'])
    })

    it('always includes View history + View audit log actions at the bottom', () => {
      const targets: TargetInfo[] = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available: false, auto: false },
        },
      ]
      setup(targets, 'local')
      const w = mountWithGlobals()
      const menu = w.findComponent({ name: 'Menu' })
      const model = menu.props('model') as Array<{ label?: string; separator?: boolean }>
      // Tail is: separator, View history, View audit log
      expect(model.at(-1)?.label).toBe('View audit log')
      expect(model.at(-2)?.label).toBe('View history')
      expect(model.at(-3)?.separator).toBe(true)
    })
  })
})
