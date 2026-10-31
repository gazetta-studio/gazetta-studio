/**
 * Pure helpers for the toolbar Save button's label + severity.
 *
 * Extracted from CmsToolbar.vue so the "save to prod" warning logic can
 * be unit-tested without mounting the component.
 *
 * Design rule (design-editor-ux.md "Making the active target
 * unmistakable"): when the active target is BOTH editable AND tagged
 * environment: production, every save click lands on live content. The
 * label and danger severity are a deliberate friction point — without
 * them, the button is visually indistinguishable from a save-to-local
 * and the author can easily forget which target they're pointed at.
 */
import type { TargetInfo } from '../api/client.js'

/**
 * True when saving this target will write to live production content —
 * i.e., it's both editable and tagged environment: production.
 */
export function isSavingToProd(target: TargetInfo | null | undefined): boolean {
  if (!target) return false
  return target.environment === 'production' && target.editable
}

/**
 * Label for the Save button: generic "Save" by default, or
 * "Save to <name>" when saving would go to an editable production target.
 */
export function saveButtonLabel(target: TargetInfo | null | undefined): string {
  if (!isSavingToProd(target)) return 'Save'
  return `Save to ${target!.name}`
}

/** Button severity for the Save button — "danger" for editable-prod. */
export function saveButtonSeverity(target: TargetInfo | null | undefined): 'primary' | 'danger' {
  return isSavingToProd(target) ? 'danger' : 'primary'
}
