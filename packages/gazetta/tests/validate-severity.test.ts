/** #1745 (T7): `gazetta validate` counts schema problems as errors; Site health keeps the scan's severity. */
import { describe, expect, it } from 'vitest'
import { CLI_SEVERITY, withCliSeverity } from '../src/cli/validate-severity.js'
import { schemaConformance } from '../src/validation/validators/schema-conformance.js'

const issue = (validator: string, severity: 'error' | 'warn' | 'info') => ({
  validator,
  severity,
  message: 'm',
  itemPath: 'pages/home/page.json',
})

describe('CLI severity', () => {
  it('maps schema-conformance to error', () => {
    expect(CLI_SEVERITY['schema-conformance']).toBe('error')
    expect(withCliSeverity(issue('schema-conformance', 'warn')).severity).toBe('error')
  })

  it.each([
    ['unused-fragment', 'info'],
    ['orphaned-locale-file', 'warn'],
    ['referenced-fragment-exists', 'error'],
  ] as const)('keeps %s at its own severity (%s)', (validator, severity) => {
    expect(withCliSeverity(issue(validator, severity)).severity).toBe(severity)
  })

  it("doesn't change the scan's severity", () => {
    expect(schemaConformance.defaultSeverity('background')).toBe('warn')
  })
})
