/**
 * Tests for Cut 9 — runtime capability inspection primitive.
 *
 * Pins the per-target capability inspection that all four
 * capability-gap surfaces consume (boot validate, /api/targets,
 * P4 validator, publish-audit).
 */
import { describe, expect, it } from 'vitest'
import type { TargetConfig } from '../src/types.js'
import { canServeRedirects, canServeGoneStatus, inspectTarget } from '../src/runtime/runtime-capabilities.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function makeTarget(overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    storage: memoryStorage(),
    ...overrides,
  } as TargetConfig
}

describe('inspectTarget', () => {
  it('plain-static target (type=static, no redirects.format) lacks both capabilities', () => {
    const target = makeTarget({ type: 'static' })
    const result = inspectTarget(target)
    expect(result.has.has('redirects')).toBe(false)
    expect(result.has.has('gone-status')).toBe(false)
    expect(result.gaps).toHaveLength(2)
    expect(result.gaps.map(g => g.capability).sort()).toEqual(['gone-status', 'redirects'])
  })

  it('static target with redirects.format=cloudflare has redirects but not gone-status', () => {
    const target = makeTarget({ type: 'static', redirects: { format: 'cloudflare' } })
    const result = inspectTarget(target)
    expect(result.has.has('redirects')).toBe(true)
    expect(result.has.has('gone-status')).toBe(false)
    expect(result.gaps.map(g => g.capability)).toEqual(['gone-status'])
  })

  it('dynamic target (worker-served) has both capabilities', () => {
    const target = makeTarget({ type: 'dynamic' })
    const result = inspectTarget(target)
    expect(result.has.has('redirects')).toBe(true)
    expect(result.has.has('gone-status')).toBe(true)
    expect(result.gaps).toEqual([])
  })

  it('static target with worker-capable deploy adapter has both capabilities', async () => {
    const { cloudflareWorkersDeploy } = await import('../src/deploy/cloudflare-workers.js')
    const target = makeTarget({
      type: 'static',
      deploy: cloudflareWorkersDeploy({ apiToken: 't', accountId: 'a', name: 'my-site', bucket: 'my-site' }),
    })
    const result = inspectTarget(target)
    expect(result.has.has('redirects')).toBe(true)
    expect(result.has.has('gone-status')).toBe(true)
  })

  it('redirects.format=none is treated like no host glue', () => {
    const target = makeTarget({ type: 'static', redirects: { format: 'none' } })
    const result = inspectTarget(target)
    expect(result.has.has('redirects')).toBe(false)
    expect(result.has.has('gone-status')).toBe(false)
  })
})

describe('canServeRedirects / canServeGoneStatus convenience predicates', () => {
  it('match inspectTarget results', () => {
    const plainStatic = makeTarget({ type: 'static' })
    const dynamic = makeTarget({ type: 'dynamic' })
    const staticWithHostGlue = makeTarget({ type: 'static', redirects: { format: 'cloudflare' } })

    expect(canServeRedirects(plainStatic)).toBe(false)
    expect(canServeGoneStatus(plainStatic)).toBe(false)
    expect(canServeRedirects(dynamic)).toBe(true)
    expect(canServeGoneStatus(dynamic)).toBe(true)
    expect(canServeRedirects(staticWithHostGlue)).toBe(true)
    expect(canServeGoneStatus(staticWithHostGlue)).toBe(false)
  })
})
