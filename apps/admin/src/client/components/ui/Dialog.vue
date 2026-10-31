<script setup lang="ts">
/**
 * Dialog (design-admin-ui.md, "The components"): Reka's Dialog with PrimeVue's
 * prop and event names (`visible` / `update:visible`, `header`, `modal`,
 * `closable`, `dismissableMask`, `#footer`), which the admin's call sites were
 * written against. Attributes (data-testid, class, style, listeners such as
 * @keydown) land on the dialog panel, not the overlay. `pt.mask.style` styles
 * the overlay (UnsavedDialog).
 */
import { X } from '@lucide/vue'
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { StyleValue } from 'vue'
import Button from './Button.vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    visible?: boolean
    header?: string
    modal?: boolean
    closable?: boolean
    dismissableMask?: boolean
    pt?: { mask?: { style?: StyleValue } }
  }>(),
  { visible: false, modal: true, closable: true, dismissableMask: false },
)

const emit = defineEmits<{ 'update:visible': [value: boolean] }>()

function onEscape(event: KeyboardEvent) {
  if (!props.closable) event.preventDefault()
}

function onOutside(event: Event) {
  if (!props.closable || !props.dismissableMask) event.preventDefault()
}

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// As PrimeVue did: focus an [autofocus] element, else the first control in the
// body or footer, so the header's close button isn't what focus lands on.
function onOpenAutoFocus(event: Event) {
  const panel = event.target as HTMLElement
  const target =
    panel.querySelector<HTMLElement>('[autofocus]') ??
    panel.querySelector<HTMLElement>(`.ui-dialog-body :is(${TABBABLE}), .ui-dialog-footer :is(${TABBABLE})`)
  if (target) {
    event.preventDefault()
    target.focus()
  }
}
</script>

<template>
  <DialogRoot :open="visible" :modal="modal" @update:open="emit('update:visible', $event)">
    <DialogPortal>
      <DialogOverlay v-if="modal" class="ui-dialog-mask" :style="pt?.mask?.style" />
      <DialogContent
        :aria-describedby="undefined"
        v-bind="$attrs"
        class="ui-dialog"
        @escape-key-down="onEscape"
        @interact-outside="onOutside"
        @open-auto-focus="onOpenAutoFocus"
      >
        <div v-if="header || closable" class="ui-dialog-header">
          <DialogTitle v-if="header" class="ui-dialog-title">{{ header }}</DialogTitle>
          <DialogClose v-if="closable" as-child>
            <Button :icon="X" text rounded severity="secondary" size="small" aria-label="Close" class="ui-dialog-close" />
          </DialogClose>
        </div>
        <div class="ui-dialog-body"><slot /></div>
        <div v-if="$slots.footer" class="ui-dialog-footer"><slot name="footer" /></div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.ui-dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: var(--color-overlay);
}
/* Centred with inset + auto margins rather than a translate, so RTL needs nothing. */
.ui-dialog {
  position: fixed;
  inset: 0;
  z-index: 1101;
  margin: auto;
  display: flex;
  flex-direction: column;
  inline-size: fit-content;
  block-size: fit-content;
  min-inline-size: min(20rem, calc(100vw - 2rem));
  max-inline-size: calc(100vw - 2rem);
  max-block-size: calc(100vh - 2rem);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-fg);
  box-shadow: var(--shadow-overlay);
}
.ui-dialog:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.ui-dialog-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-block: 1rem 0.5rem;
  padding-inline: 1.25rem 0.75rem;
}
.ui-dialog-title {
  flex: 1;
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.5rem;
}
.ui-dialog-close {
  margin-inline-start: auto;
}
.ui-dialog-body {
  flex: 1;
  min-block-size: 0;
  overflow: auto;
  padding-block: 0.5rem 1rem;
  padding-inline: 1.25rem;
}
.ui-dialog-header + .ui-dialog-body {
  padding-block-start: 0.25rem;
}
.ui-dialog-footer {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding-block: 0.75rem 1rem;
  padding-inline: 1.25rem;
  border-block-start: 1px solid var(--color-border);
}
</style>
