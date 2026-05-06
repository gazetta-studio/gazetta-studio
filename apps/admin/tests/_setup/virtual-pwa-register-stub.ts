/**
 * Stub for `virtual:pwa-register/vue` used during vitest runs.
 *
 * vite-plugin-pwa creates the `virtual:pwa-register/vue` module at
 * build time only — vitest's dev resolver doesn't see it. Aliasing
 * the module to this stub via `vitest.config.ts resolve.alias`
 * lets `useServiceWorkerUpdate.ts` import it during tests without
 * the plugin being active.
 *
 * The stub is intentionally minimal: a no-op `useRegisterSW` that
 * returns reactive shapes matching the real module's contract.
 * Tests that need to drive the update flow re-mock the module via
 * `vi.mock('virtual:pwa-register/vue', ...)` to inject behavior;
 * this stub only handles the "tests that don't care about SW
 * registration but happen to touch a module that imports it"
 * case.
 */
import { ref } from 'vue'

export function useRegisterSW() {
  return {
    needRefresh: ref(false),
    offlineReady: ref(false),
    updateServiceWorker: async () => {},
  }
}
