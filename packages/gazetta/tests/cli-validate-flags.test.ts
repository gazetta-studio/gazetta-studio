/**
 * Unit tests for `parseValidateFlags` — the argument parser for the
 * `gazetta validate` CLI command (Validation Cut 5).
 *
 * Pinning the flag contract per design-validation-implementation.md:
 *   --severity error|warn|all
 *   --include-quality
 *   --no-warn-as-error
 *   --verbose / -v
 */
import { describe, it, expect } from 'vitest'
import { parseValidateFlags } from '../src/cli/validate-flags.js'

describe('parseValidateFlags', () => {
  it('returns the documented defaults on no args', () => {
    expect(parseValidateFlags([])).toEqual({
      severity: 'error',
      includeQuality: false,
      warnAsError: true,
      verbose: false,
    })
  })

  it('parses --severity warn', () => {
    expect(parseValidateFlags(['--severity', 'warn']).severity).toBe('warn')
  })

  it('parses --severity=warn (= form)', () => {
    expect(parseValidateFlags(['--severity=warn']).severity).toBe('warn')
  })

  it('parses --severity all', () => {
    expect(parseValidateFlags(['--severity', 'all']).severity).toBe('all')
  })

  it('ignores invalid severity values', () => {
    expect(parseValidateFlags(['--severity', 'critical']).severity).toBe('error')
    expect(parseValidateFlags(['--severity=lol']).severity).toBe('error')
  })

  it('parses --include-quality', () => {
    expect(parseValidateFlags(['--include-quality']).includeQuality).toBe(true)
  })

  it('parses --no-warn-as-error', () => {
    expect(parseValidateFlags(['--no-warn-as-error']).warnAsError).toBe(false)
  })

  it('parses --verbose and -v', () => {
    expect(parseValidateFlags(['--verbose']).verbose).toBe(true)
    expect(parseValidateFlags(['-v']).verbose).toBe(true)
  })

  it('combines flags', () => {
    const opts = parseValidateFlags(['--include-quality', '--severity=all', '--verbose', '--no-warn-as-error'])
    expect(opts).toEqual({
      severity: 'all',
      includeQuality: true,
      warnAsError: false,
      verbose: true,
    })
  })

  it('ignores unknown args', () => {
    const opts = parseValidateFlags(['--unknown', 'value', '--include-quality'])
    expect(opts.includeQuality).toBe(true)
  })
})
