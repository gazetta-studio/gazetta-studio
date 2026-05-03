/**
 * Unit tests for targetGrouping helpers. Covers the "4+ targets →
 * group by environment" rule from design-editor-ux.md.
 */
import { describe, it, expect } from 'vitest'
import type { TargetInfo } from '../src/client/api/client.js'
import {
  GROUPING_THRESHOLD,
  groupByEnvironment,
  groupedEntries,
  shouldGroup,
} from '../src/client/composables/targetGrouping.js'

function T(name: string, environment: 'local' | 'staging' | 'production'): TargetInfo {
  return {
    name,
    environment,
    type: 'static',
    editable: environment === 'local',
    altText: { available: false, auto: false },
  }
}

describe('shouldGroup', () => {
  it(`false below threshold (< ${GROUPING_THRESHOLD})`, () => {
    expect(shouldGroup(0)).toBe(false)
    expect(shouldGroup(1)).toBe(false)
    expect(shouldGroup(3)).toBe(false)
  })
  it(`true at and above threshold (>= ${GROUPING_THRESHOLD})`, () => {
    expect(shouldGroup(GROUPING_THRESHOLD)).toBe(true)
    expect(shouldGroup(10)).toBe(true)
  })
})

describe('groupByEnvironment', () => {
  it('groups targets sharing an environment, preserving declaration order', () => {
    const targets = [
      T('local', 'local'),
      T('prod-us', 'production'),
      T('staging', 'staging'),
      T('prod-eu', 'production'),
    ]
    const groups = groupByEnvironment(targets)
    expect(groups.map(g => g.environment)).toEqual(['local', 'production', 'staging'])
    const prod = groups.find(g => g.environment === 'production')!
    expect(prod.members.map(m => m.name)).toEqual(['prod-us', 'prod-eu'])
  })

  it('empty input → empty output', () => {
    expect(groupByEnvironment([])).toEqual([])
  })
})

describe('groupedEntries', () => {
  const starter: TargetInfo[] = [
    T('local', 'local'),
    T('staging', 'staging'),
    T('esi-test', 'staging'),
    T('production', 'production'),
  ]

  it('flat (single) entries when total count is below threshold', () => {
    // Three targets → flat, even if two share an env.
    const three = starter.slice(0, 3)
    const entries = groupedEntries(three, three.length)
    expect(entries).toHaveLength(3)
    expect(entries.every(e => e.kind === 'single')).toBe(true)
  })

  it('groups multi-member environments at the 4+ threshold', () => {
    const entries = groupedEntries(starter, starter.length)
    // local (1) → single, staging (2) → group, production (1) → single.
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({ kind: 'single', target: starter[0] })
    expect(entries[1].kind).toBe('group')
    if (entries[1].kind === 'group') {
      expect(entries[1].group.environment).toBe('staging')
      expect(entries[1].group.members).toHaveLength(2)
    }
    expect(entries[2]).toEqual({ kind: 'single', target: starter[3] })
  })

  it('1-member groups render flat even when grouping is active', () => {
    const entries = groupedEntries(starter, starter.length)
    const production = entries.find(e => e.kind === 'single' && e.target.environment === 'production')
    expect(production).toBeDefined()
    expect(production?.kind).toBe('single')
  })

  it('uses the passed total count, not entries.length, for the threshold', () => {
    // Non-active targets (3) below threshold individually, but total is 4 →
    // still group. The caller passes the full fleet size so filtered views
    // (e.g. sync indicators, which hide the active) share the same shape.
    const nonActive = starter.slice(1)
    const entries = groupedEntries(nonActive, starter.length)
    // staging (2) should still collapse into a group.
    const grouped = entries.find(e => e.kind === 'group')
    expect(grouped).toBeDefined()
  })
})
