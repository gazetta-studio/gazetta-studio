import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useValidationIssuesStore } from '../src/client/stores/validationIssues.js'
import type { ValidationIssue } from '../src/client/api/client.js'

const ERROR_ISSUE: ValidationIssue = {
  validator: 'referenced-asset-exists',
  severity: 'error',
  message: 'Asset "hero" missing.',
  itemPath: 'pages/home/page.json',
}
const WARN_ISSUE: ValidationIssue = {
  validator: 'unused-fragment',
  severity: 'warn',
  message: 'Fragment "old-banner" is unused.',
  itemPath: 'fragments/old-banner/fragment.json',
}

describe('validationIssues store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts empty', () => {
    const store = useValidationIssuesStore()
    expect(store.issues).toEqual([])
    expect(store.hasIssues).toBe(false)
    expect(store.errorCount).toBe(0)
  })

  it('set populates issues', () => {
    const store = useValidationIssuesStore()
    store.set([ERROR_ISSUE, WARN_ISSUE])
    expect(store.issues).toHaveLength(2)
    expect(store.hasIssues).toBe(true)
  })

  it('errorCount counts only error-severity', () => {
    const store = useValidationIssuesStore()
    store.set([ERROR_ISSUE, WARN_ISSUE, { ...ERROR_ISSUE, validator: 'circular-fragment' }])
    expect(store.errorCount).toBe(2)
  })

  it('clear empties the store', () => {
    const store = useValidationIssuesStore()
    store.set([ERROR_ISSUE])
    store.clear()
    expect(store.issues).toEqual([])
    expect(store.hasIssues).toBe(false)
  })
})
