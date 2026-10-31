<script setup lang="ts">
import Splitter from './ui/Splitter.vue'
import SplitterPanel from './ui/SplitterPanel.vue'
import { onKeyStroke } from '@vueuse/core'
import { useRouter } from 'vue-router'
import SiteTree from './SiteTree.vue'
import ComponentTree from './ComponentTree.vue'
import EditorPanel from './EditorPanel.vue'
import PreviewPanel from './PreviewPanel.vue'
import { useUiModeStore } from '../stores/uiMode.js'
import { useSelectionStore } from '../stores/selection.js'
import { useUnsavedGuardStore } from '../stores/unsavedGuard.js'

const router = useRouter()
const uiMode = useUiModeStore()
const selection = useSelectionStore()
const unsavedGuard = useUnsavedGuardStore()

onKeyStroke('Escape', () => {
  if (unsavedGuard.visible) return
  if (uiMode.mode === 'fullscreen') {
    uiMode.toggleFullscreen()
    return
  }
  if (uiMode.mode !== 'edit') return
  const active = document.activeElement as HTMLElement | null
  if (
    active &&
    (active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.isContentEditable)
  ) {
    active.blur()
    return
  }
  if (!selection.name) return
  const prefix = selection.type === 'page' ? '/pages' : '/fragments'
  router.push(`${prefix}/${selection.name}`)
})
</script>

<template>
  <div class="cms-editor">
    <div class="cms-left" :class="{ 'cms-left-wide': uiMode.mode === 'edit' }">
      <!-- Browse: SiteTree -->
      <div v-if="uiMode.mode === 'browse'" class="cms-panel-content">
        <SiteTree />
      </div>
      <!-- Edit: ComponentTree + Editor with drag-to-resize -->
      <Splitter v-else class="cms-splitter">
        <SplitterPanel :size="35" :minSize="25" class="cms-panel">
          <div class="cms-panel-content">
            <ComponentTree />
          </div>
        </SplitterPanel>
        <SplitterPanel :size="65" :minSize="35" class="cms-panel">
          <div class="cms-panel-content">
            <EditorPanel />
          </div>
        </SplitterPanel>
      </Splitter>
    </div>
    <div class="cms-preview">
      <PreviewPanel />
    </div>
  </div>
</template>

<style scoped>
.cms-editor { display: flex; height: calc(100% - 60px); }
.cms-left { width: 250px; flex-shrink: 0; overflow: auto; border-right: 1px solid #27272a; }
.cms-left-wide { width: 55%; max-width: 900px; overflow: hidden; }
.cms-splitter { height: 100%; border: 0; border-radius: 0; }
.cms-preview { flex: 1; min-width: 0; overflow: hidden; }
.cms-panel { overflow: auto; }
.cms-panel-content { padding: 1rem; }
</style>
