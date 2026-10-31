<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLocaleStore } from '../stores/locale.js'

const route = useRoute()
const router = useRouter()
const locale = useLocaleStore()

const activeLabel = computed(() => (locale.activeLocale ?? locale.defaultLocale)?.toUpperCase() ?? 'EN')
const useDropdown = computed(() => (locale.siteLocales?.length ?? 0) > 4)

function switchLocale(loc: string) {
  const isDefault = loc === locale.defaultLocale
  const current = route.query
  const hash = route.hash
  // Explicitly set locale to undefined to signal the persistent-query guard
  // that this is an intentional removal, not a forgotten param.
  router.push({ query: { ...current, locale: isDefault ? undefined : loc }, hash })
}
</script>

<template>
  <div v-if="locale.isEnabled" class="locale-picker" data-testid="locale-picker">
    <!-- Inline buttons for ≤4 locales -->
    <template v-if="!useDropdown">
      <button
        v-for="loc in locale.siteLocales"
        :key="loc"
        :class="['locale-btn', { active: (locale.activeLocale ?? locale.defaultLocale) === loc }]"
        :data-testid="`locale-${loc}`"
        @click="switchLocale(loc)"
      >{{ loc.toUpperCase() }}</button>
    </template>
    <!-- Dropdown for 5+ locales -->
    <template v-else>
      <div class="locale-dropdown">
        <button class="locale-btn active locale-trigger" data-testid="locale-dropdown-trigger">
          {{ activeLabel }} <ChevronDown class="locale-chevron" aria-hidden="true" />
        </button>
        <div class="locale-menu">
          <button
            v-for="loc in locale.siteLocales"
            :key="loc"
            :class="['locale-menu-item', { active: (locale.activeLocale ?? locale.defaultLocale) === loc }]"
            :data-testid="`locale-${loc}`"
            @click="switchLocale(loc)"
          >{{ loc.toUpperCase() }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.locale-picker { display: flex; gap: 2px; align-items: center; margin-left: 0.5rem; }
.locale-btn {
  background: none; border: 1px solid var(--color-border); color: var(--color-muted);
  font-size: 0.625rem; font-weight: 700; letter-spacing: 0.05em;
  padding: 0.125rem 0.375rem; border-radius: 3px; cursor: pointer;
  transition: all 0.15s;
}
.locale-btn:hover { color: var(--color-fg); border-color: var(--color-fg); }
.locale-btn.active { color: var(--color-primary); border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 10%, transparent); }

/* Dropdown */
.locale-dropdown { position: relative; }
.locale-trigger { display: flex; align-items: center; gap: 2px; }
.locale-chevron { inline-size: 0.5rem; block-size: 0.5rem; }
.locale-menu {
  display: none; position: absolute; top: 100%; left: 0; margin-top: 4px;
  background: var(--color-bg); border: 1px solid var(--color-border);
  border-radius: 4px; padding: 2px; z-index: 100; min-width: 48px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.locale-dropdown:hover .locale-menu,
.locale-dropdown:focus-within .locale-menu { display: flex; flex-direction: column; gap: 1px; }
.locale-menu-item {
  background: none; border: none; color: var(--color-muted);
  font-size: 0.625rem; font-weight: 700; letter-spacing: 0.05em;
  padding: 0.25rem 0.5rem; cursor: pointer; text-align: left;
  border-radius: 2px; transition: all 0.15s;
}
.locale-menu-item:hover { background: var(--color-hover-bg); color: var(--color-fg); }
.locale-menu-item.active { color: var(--color-primary); }
</style>
