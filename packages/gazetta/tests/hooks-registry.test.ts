/**
 * Cut 2 tests: HookRegistry — priority ordering + sealing.
 *
 * Pinned invariants per design-hooks.md "Composition (Q3 locked)":
 *   - Lower priority runs earlier; default 100
 *   - Same priority resolves to registration order (stable sort)
 *   - getByPhase returns a fresh array (callers can mutate freely)
 *   - register() throws RegistrationAfterInitError after seal()
 *   - seal() is idempotent
 */
import { describe, expect, it } from 'vitest'
import { HookRegistry, RegistrationAfterInitError } from '../src/hooks/index.js'
import type { BeforeSaveHook } from '../src/hooks/index.js'

const noopBeforeSave: BeforeSaveHook = async (_scope, payload, _ctx) => payload

describe('Cut 2 — HookRegistry priority + tie-break', () => {
  it('returns handlers in priority order (lower first)', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { priority: 200, name: 'mid' })
    r.register('beforeSave', noopBeforeSave, { priority: 50, name: 'early' })
    r.register('beforeSave', noopBeforeSave, { priority: 1000, name: 'late' })
    const order = r.getByPhase('beforeSave').map(reg => reg.name)
    expect(order).toEqual(['early', 'mid', 'late'])
  })

  it('default priority is 100', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { name: 'no-priority' })
    expect(r.getByPhase('beforeSave')[0].priority).toBe(100)
  })

  it('default timeout is 5000', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { name: 'no-timeout' })
    expect(r.getByPhase('beforeSave')[0].timeout).toBe(5000)
  })

  it('breaks ties by registration order (stable sort)', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { priority: 100, name: 'first' })
    r.register('beforeSave', noopBeforeSave, { priority: 100, name: 'second' })
    r.register('beforeSave', noopBeforeSave, { priority: 100, name: 'third' })
    const order = r.getByPhase('beforeSave').map(reg => reg.name)
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('preserves stable order across mixed priorities', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { priority: 100, name: 'a-100' })
    r.register('beforeSave', noopBeforeSave, { priority: 50, name: 'b-50' })
    r.register('beforeSave', noopBeforeSave, { priority: 100, name: 'c-100' })
    r.register('beforeSave', noopBeforeSave, { priority: 50, name: 'd-50' })
    const order = r.getByPhase('beforeSave').map(reg => reg.name)
    // priority-50 group first (in registration order), then priority-100
    expect(order).toEqual(['b-50', 'd-50', 'a-100', 'c-100'])
  })

  it('separates phases — registrations to one phase do not appear in another', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { name: 'save-hook' })
    expect(r.getByPhase('beforeSave')).toHaveLength(1)
    expect(r.getByPhase('afterSave')).toHaveLength(0)
    expect(r.getByPhase('beforePublish')).toHaveLength(0)
  })

  it('size() returns total or per-phase count', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave)
    r.register('beforeSave', noopBeforeSave)
    r.register('afterSave', async () => {})
    expect(r.size('beforeSave')).toBe(2)
    expect(r.size('afterSave')).toBe(1)
    expect(r.size()).toBe(3)
  })

  it('returns a fresh array — mutating result does not affect registry', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { name: 'a' })
    r.register('beforeSave', noopBeforeSave, { name: 'b' })
    const first = r.getByPhase('beforeSave')
    // Mutate the returned array (push a fake entry)
    ;(first as unknown as { length: number }).length = 0
    // Registry unaffected
    expect(r.getByPhase('beforeSave')).toHaveLength(2)
  })

  it('records source identity (default site-local)', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { name: 'a' })
    r.register('beforeSave', noopBeforeSave, { name: 'b' }, '@my-org/plugin')
    const regs = r.getByPhase('beforeSave')
    expect(regs[0].source).toBe('site-local')
    expect(regs[1].source).toBe('@my-org/plugin')
  })

  it('falls back to source as name when name omitted', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, {}, '@my-org/plugin')
    expect(r.getByPhase('beforeSave')[0].name).toBe('@my-org/plugin')
  })
})

describe('Cut 2 — HookRegistry sealing', () => {
  it('seal() prevents subsequent register() calls', () => {
    const r = new HookRegistry()
    r.register('beforeSave', noopBeforeSave, { name: 'pre-seal' })
    r.seal()
    expect(() => r.register('beforeSave', noopBeforeSave, { name: 'post-seal' })).toThrow(RegistrationAfterInitError)
    expect(r.size('beforeSave')).toBe(1)
  })

  it('seal() is idempotent', () => {
    const r = new HookRegistry()
    r.seal()
    r.seal()
    expect(r.isSealed()).toBe(true)
  })

  it('isSealed() reports the state', () => {
    const r = new HookRegistry()
    expect(r.isSealed()).toBe(false)
    r.seal()
    expect(r.isSealed()).toBe(true)
  })

  it('RegistrationAfterInitError carries source + phase', () => {
    const r = new HookRegistry()
    r.seal()
    try {
      r.register('beforePublish', async (_t, items) => items, { name: 'late' }, '@my-org/late')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(RegistrationAfterInitError)
      const reg = err as RegistrationAfterInitError
      expect(reg.source).toBe('@my-org/late')
      expect(reg.phase).toBe('beforePublish')
    }
  })
})
