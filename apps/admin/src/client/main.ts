import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import { VueQueryPlugin } from '@tanstack/vue-query'
import App from './App.vue'
import { createRouter } from './router.js'
import { selectBrowserCacheProvider } from './cache/provider-selector.js'
import { createAdminQueryClient, createGazettaClientPersister } from './queries/client.js'
import { createGazettaPersister } from './queries/persister.js'
import './assets/tokens.css'

// Async boot: provider selection probes IndexedDB before constructing
// the L6 cache. Vue's createApp is sync but Vue's plugin install can
// run after creation, so we resolve the provider first and feed it
// into the VueQueryPlugin install.
async function bootstrap(): Promise<void> {
  const provider = await selectBrowserCacheProvider()
  const queryClient = createAdminQueryClient()
  const persister = createGazettaPersister(provider.cache)
  const clientPersister = createGazettaClientPersister(persister)

  const app = createApp(App)
  app.use(createPinia())
  app.use(PrimeVue, {
    theme: {
      preset: Aura,
      options: { darkModeSelector: '.dark' },
    },
  })
  app.use(VueQueryPlugin, {
    queryClient,
    clientPersister,
  })
  app.use(createRouter())
  app.mount('#app')

  if (provider.degraded) {
    // Surface persistence degradation to operators via console for
    // now; the user-facing banner lands as a Vue component reading
    // a Pinia flag in a later cut. Reason field carries the probe
    // failure for diagnostic logs.
    console.warn(
      `[gazetta] offline persistence unavailable — using in-memory cache. Reason: ${provider.reason ?? 'unknown'}`,
    )
  }
}

void bootstrap()

// User theme — append AFTER PrimeVue and tokens.css so user declarations
// win the cascade. PrimeVue injects styles at runtime via app.use(PrimeVue),
// so a static <link> in index.html would lose to it. The server returns an
// empty stylesheet when the user has no admin/theme.css, so no onerror
// handling needed.
{
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/admin/theme.css'
  document.head.appendChild(link)
}
