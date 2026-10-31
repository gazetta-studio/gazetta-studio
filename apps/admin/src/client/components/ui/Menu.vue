<script lang="ts">
import type { Component } from 'vue'

/** A Menu item, in PrimeVue's MenuItem shape (the fields the admin uses). */
export interface MenuItem {
  label?: string
  icon?: Component
  /** `'active'` marks the current item. */
  class?: string
  command?: (event: { originalEvent: Event; item: MenuItem }) => void
  /** Child items render as a group under this item's label. */
  items?: MenuItem[]
  separator?: boolean
  disabled?: boolean
  visible?: boolean
  key?: string
}
</script>

<script setup lang="ts">
/**
 * Menu (design-admin-ui.md, "The components"): a popup menu on Reka's
 * DropdownMenu with PrimeVue's API: `:model` items and `toggle(event)` from a
 * separate button, positioned against `event.currentTarget`. Item `items`
 * make a labelled group, `separator: true` a separator, `class: 'active'`
 * marks the current item. Attributes (data-testid, aria-label) land on the
 * menu content.
 */
import { Check } from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
} from 'reka-ui'
import { ref } from 'vue'

defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{ model?: MenuItem[]; popup?: boolean }>(), { model: () => [], popup: true })

const open = ref(false)
const reference = ref<HTMLElement>()
const referenceKey = ref(0)

function show(event: Event) {
  if (event.currentTarget instanceof HTMLElement && event.currentTarget !== reference.value) {
    reference.value = event.currentTarget
    referenceKey.value++
  }
  open.value = true
}
function hide() {
  open.value = false
}
function toggle(event: Event) {
  if (open.value) hide()
  else show(event)
}

defineExpose({ toggle, show, hide })

const isActive = (item: MenuItem) => item.class === 'active' || item.class?.split(/\s+/).includes('active')
const visible = (items: MenuItem[]) => items.filter(item => item.visible !== false)

function select(item: MenuItem, event: Event) {
  item.command?.({ originalEvent: event, item })
}

// Set when a click or focus elsewhere closes the menu: focus then stays where
// the user moved it instead of returning to the opening button.
let interactedOutside = false

// A press on the button that opened the menu would close it here and reopen
// it in the button's own click handler; leave closing to toggle().
function onInteractOutside(event: Event) {
  if (reference.value && event.target instanceof Node && reference.value.contains(event.target)) event.preventDefault()
  else interactedOutside = true
}

// Without a Reka trigger, return focus to the opening button ourselves.
function onCloseAutoFocus(event: Event) {
  event.preventDefault()
  if (!interactedOutside) reference.value?.focus()
  interactedOutside = false
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuPortal>
      <!-- Reka's content ignores a `reference` that arrives after it was created
           (the menu is never positioned), so create it once there is one, and
           again for each new one. -->
      <DropdownMenuContent
        v-if="reference"
        :key="referenceKey"
        class="ui-menu"
        :reference="reference"
        align="start"
        :side-offset="4"
        :aria-labelledby="reference?.id || undefined"
        v-bind="$attrs"
        @interact-outside="onInteractOutside"
        @close-auto-focus="onCloseAutoFocus"
      >
        <template v-for="(item, i) in visible(model)" :key="item.key ?? i">
          <DropdownMenuSeparator v-if="item.separator" class="ui-menu-separator" />
          <DropdownMenuGroup v-else-if="item.items" class="ui-menu-group">
            <DropdownMenuLabel class="ui-menu-label">{{ item.label }}</DropdownMenuLabel>
            <DropdownMenuItem
              v-for="(child, j) in visible(item.items)"
              :key="child.key ?? j"
              class="ui-menu-item"
              :class="child.class"
              :disabled="child.disabled"
              :data-active="isActive(child) || undefined"
              :aria-current="isActive(child) || undefined"
              @select="select(child, $event)"
            >
              <component :is="child.icon" v-if="child.icon" class="ui-menu-icon" aria-hidden="true" />
              <span class="ui-menu-text">{{ child.label }}</span>
              <Check v-if="isActive(child)" class="ui-menu-check" aria-hidden="true" />
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuItem
            v-else
            class="ui-menu-item"
            :class="item.class"
            :disabled="item.disabled"
            :data-active="isActive(item) || undefined"
            :aria-current="isActive(item) || undefined"
            @select="select(item, $event)"
          >
            <component :is="item.icon" v-if="item.icon" class="ui-menu-icon" aria-hidden="true" />
            <span class="ui-menu-text">{{ item.label }}</span>
            <Check v-if="isActive(item)" class="ui-menu-check" aria-hidden="true" />
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<!-- Not scoped: Reka renders the teleported content element itself, so it never
     gets this component's scope attribute. The ui-menu prefix keeps it contained. -->
<style>
.ui-menu {
  z-index: 1200;
  min-inline-size: 12rem;
  max-block-size: var(--reka-dropdown-menu-content-available-height);
  overflow-y: auto;
  padding: 0.25rem;
  background: var(--color-bg);
  color: var(--color-fg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-overlay);
  font-size: 0.875rem;
}
.ui-menu:focus-visible {
  outline: none;
}
.ui-menu-label {
  padding-block: 0.375rem 0.25rem;
  padding-inline: 0.5rem;
  color: var(--color-muted);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ui-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-block: 0.375rem;
  padding-inline: 0.5rem;
  border-radius: var(--radius-sm);
  line-height: 1.25rem;
  cursor: pointer;
  user-select: none;
  outline: none;
}
.ui-menu-group .ui-menu-item {
  padding-inline-start: 1rem;
}
.ui-menu-item[data-highlighted] {
  background: var(--color-hover-bg);
}
.ui-menu-item:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: calc(-1 * var(--focus-ring-width));
}
.ui-menu-item[data-disabled] {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-menu-item[data-active] {
  font-weight: 600;
}
.ui-menu-text {
  flex: 1;
}
.ui-menu-icon,
.ui-menu-check {
  inline-size: 1rem;
  block-size: 1rem;
  flex-shrink: 0;
}
.ui-menu-icon {
  color: var(--color-muted);
}
.ui-menu-item[data-active] .ui-menu-icon,
.ui-menu-check {
  color: var(--color-primary);
}
.ui-menu-separator {
  block-size: 1px;
  margin-block: 0.25rem;
  background: var(--color-border);
}
</style>
