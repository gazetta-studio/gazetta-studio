/**
 * Unit tests for saveButtonBinding helpers. Covers the rule from
 * design-editor-ux.md: editable production → "Save to <name>" + danger;
 * everything else → "Save" + primary.
 */
import { describe, it, expect } from 'vitest'
import type { TargetInfo } from '../src/client/api/client.js'
import { isSavingToProd, saveButtonLabel, saveButtonSeverity } from '../src/client/composables/saveButtonBinding.js'

const LOCAL: TargetInfo = {
  name: 'local',
  environment: 'local',
  type: 'static',
  editable: true,
  altText: { available: false, auto: false },
}
const STAGING: TargetInfo = {
  name: 'staging',
  environment: 'staging',
  type: 'static',
  editable: true,
  altText: { available: false, auto: false },
}
const PROD_READONLY: TargetInfo = {
  name: 'prod',
  environment: 'production',
  type: 'static',
  editable: false,
  altText: { available: false, auto: false },
}
const PROD_HOTFIX: TargetInfo = {
  name: 'prod',
  environment: 'production',
  type: 'static',
  editable: true,
  altText: { available: false, auto: false },
}

describe('isSavingToProd', () => {
  it('true only when target is editable AND environment is production', () => {
    expect(isSavingToProd(PROD_HOTFIX)).toBe(true)
  })

  it('false for editable non-production targets (local, staging)', () => {
    expect(isSavingToProd(LOCAL)).toBe(false)
    expect(isSavingToProd(STAGING)).toBe(false)
  })

  it('false for read-only production (no save will happen anyway)', () => {
    expect(isSavingToProd(PROD_READONLY)).toBe(false)
  })

  it('false for null / undefined target', () => {
    expect(isSavingToProd(null)).toBe(false)
    expect(isSavingToProd(undefined)).toBe(false)
  })
})

describe('saveButtonLabel', () => {
  it('"Save" for non-prod editable targets', () => {
    expect(saveButtonLabel(LOCAL)).toBe('Save')
    expect(saveButtonLabel(STAGING)).toBe('Save')
  })

  it('"Save to <name>" for editable production', () => {
    expect(saveButtonLabel(PROD_HOTFIX)).toBe('Save to prod')
  })

  it('uses the target name so multi-region prod (e.g. prod-us) is unambiguous', () => {
    const prodUs: TargetInfo = {
      name: 'prod-us',
      environment: 'production',
      type: 'static',
      editable: true,
      altText: { available: false, auto: false },
    }
    expect(saveButtonLabel(prodUs)).toBe('Save to prod-us')
  })

  it('"Save" for null target (the button is usually hidden or disabled here)', () => {
    expect(saveButtonLabel(null)).toBe('Save')
  })
})

describe('saveButtonSeverity', () => {
  it('danger only for editable production', () => {
    expect(saveButtonSeverity(PROD_HOTFIX)).toBe('danger')
  })

  it('primary for everything else', () => {
    expect(saveButtonSeverity(LOCAL)).toBe('primary')
    expect(saveButtonSeverity(STAGING)).toBe('primary')
    expect(saveButtonSeverity(PROD_READONLY)).toBe('primary')
    expect(saveButtonSeverity(null)).toBe('primary')
  })
})
