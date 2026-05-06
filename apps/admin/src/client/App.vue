<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useSiteStore } from './stores/site.js'
import { useThemeStore } from './stores/theme.js'
import { useToastStore } from './stores/toast.js'
import { useActiveTargetStore } from './stores/activeTarget.js'
import { useSyncStatusStore } from './stores/syncStatus.js'
import { setActiveTargetProvider } from './api/client.js'
import { useWorkspaceChrome } from './composables/useWorkspaceChrome.js'
import { useAssetLibraryShortcut } from './composables/useAssetLibraryShortcut.js'
import Toolbar from './components/CmsToolbar.vue'
import UnsavedDialog from './components/UnsavedDialog.vue'
import AssetLibrary from './components/AssetLibrary.vue'
import AssetPicker from './components/AssetPicker.vue'
import AssetDeleteConfirm from './components/AssetDeleteConfirm.vue'
import OfflineBanner from './components/OfflineBanner.vue'

const site = useSiteStore()
const theme = useThemeStore()
const toast = useToastStore()
const activeTarget = useActiveTargetStore()
const syncStatus = useSyncStatusStore()

// Apply workspace-wide chrome when the active target is an editable
// production target. Kept out of App.vue's inline setup so the rule has
// a clear home and can evolve without the root component knowing.
useWorkspaceChrome()

// Register Cmd+L / Ctrl+L to toggle the asset library modal. Lives here
// because the binding must be active regardless of which route is shown.
useAssetLibraryShortcut()

// Bridge the active-target store to the api client — from now on, every
// content-reading request auto-appends ?target=<active>. Done once at boot;
// the api client reads the current value on each request.
setActiveTargetProvider(() => activeTarget.activeTargetName)

// Wire sync-status store to read its inputs from the active-target store.
// Dependency injection keeps the stores decoupled — neither imports the
// other at module-load time.
syncStatus.configure({
  listTargets: () => activeTarget.targets,
  activeTarget: () => activeTarget.activeTargetName,
})

// Reload site + content when the active target switches. Invalidate the
// previously-active target's sync status (it'll be recomputed next refresh)
// and kick off a new sync refresh for the now-non-active targets.
watch(
  () => activeTarget.activeTargetName,
  (name, prev) => {
    if (name && prev && name !== prev) {
      site.reload()
      // The new active target no longer needs a sync status; the previously
      // active one does (from source perspective). Easiest: clear + refresh.
      syncStatus.clear()
      syncStatus.refreshAll()
    }
  },
)

// After the target list loads for the first time, run the initial compare.
watch(
  () => activeTarget.targets.length,
  n => {
    if (n > 1) syncStatus.refreshAll()
  },
)

onMounted(() => {
  theme.init()
  activeTarget.load()
})
</script>

<template>
  <div class="cms-app">
    <Toolbar />
    <OfflineBanner />
    <div v-if="site.error" class="cms-error">{{ site.error }}</div>
    <!-- Only block on the first load. Subsequent reloads (e.g., on
         active-target switch) keep the router-view mounted so the
         preview iframe survives — unmounting would drop scroll/zoom
         and defeat the "cheap comparison" intent of preview tabs. -->
    <div v-else-if="!site.manifest" class="cms-loading">Loading site...</div>
    <router-view v-else />

    <UnsavedDialog />
    <AssetLibrary />
    <AssetPicker />
    <AssetDeleteConfirm />

    <!-- Global toast — visible over everything including fullscreen -->
    <Transition name="toast">
      <div v-if="toast.current" class="global-toast"
        :class="`toast-${toast.current.type}`" data-testid="global-toast">
        <i :class="toast.current.type === 'error' ? 'pi pi-exclamation-circle'
          : toast.current.type === 'info' ? 'pi pi-info-circle' : 'pi pi-check-circle'" />
        <a v-if="toast.current.link" :href="toast.current.link" target="_blank" rel="noopener" class="toast-link">{{ toast.current.message }}</a>
        <template v-else>{{ toast.current.message }}</template>
        <button v-if="toast.current.action" type="button" class="toast-action"
          data-testid="toast-action" @click="toast.runAction()">
          {{ toast.current.action.label }}
        </button>
        <button v-if="toast.current.type === 'error'" type="button" class="toast-dismiss" data-testid="toast-dismiss"
          aria-label="Dismiss" @click="toast.dismiss()">
          <i class="pi pi-times" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #app, .cms-app { height: 100%; }
body { font-family: system-ui, -apple-system, sans-serif; color: var(--color-fg); background: var(--color-bg); }
.cms-error { padding: 2rem; color: var(--color-danger-fg); }
.cms-loading { padding: 2rem; color: var(--color-muted); }
.global-toast { position: fixed; top: 0; left: 50%; transform: translateX(-50%); z-index: 1001; background: var(--color-bg); color: var(--color-fg); border: 1px solid var(--color-border); border-top: none; border-radius: 0 0 8px 8px; padding: 8px 20px; font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 400px; }
.toast-success { color: var(--color-success-fg); }
.toast-error { color: var(--color-danger-fg); }
.toast-info { color: var(--color-info-fg); }
.toast-link { color: inherit; text-decoration: underline; }
.toast-action { background: transparent; border: 0; color: inherit; cursor: pointer; padding: 2px 6px; margin-left: 4px; font: inherit; font-weight: 600; text-decoration: underline; }
.toast-action:hover { opacity: 0.8; }
.toast-dismiss { background: transparent; border: 0; color: inherit; cursor: pointer; padding: 2px 4px; margin-left: 4px; opacity: 0.7; display: flex; align-items: center; }
.toast-dismiss:hover { opacity: 1; }
.toast-dismiss .pi { font-size: 11px; }
.toast-enter-active { transition: transform 200ms ease-out, opacity 200ms ease-out; }
.toast-leave-active { transition: transform 150ms ease-in, opacity 150ms ease-in; }
.toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(-100%); }
.toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(-100%); }

/* Workspace chrome — applied when the active target is an editable
   production target. Matches the "permanent editing" intensity from
   design-editor-ux.md: the author needs a constant visual reminder that
   every save goes live.

   Kept as a frame on the window (fixed position, top of z-stack) so it
   remains visible even in preview fullscreen. Subtle enough not to fight
   the content, bold enough to catch peripheral vision. */
body.workspace-editable-prod::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  border: 3px solid var(--color-env-prod-fg);
  z-index: 9999;
}
</style>
