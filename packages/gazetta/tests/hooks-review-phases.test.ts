/**
 * Cut 8 tests: review-lifecycle hook phase types (forward-compat).
 *
 * Per design-hooks.md Cut 8 + design-review-workflow-implementation.md
 * Cut 14: v1 ships the 10 review-lifecycle phase types so plugins +
 * site-local hooks can target them. The state machine that fires
 * these transitions ships in Phase 2 (review workflow).
 *
 * Tests pin:
 *   - HookPhase enum includes the 10 review phases
 *   - HookHandler<P> re-narrows correctly per phase
 *   - HookRegistry accepts review-phase registrations under the
 *     same priority + sealing semantics as v1 phases
 *   - ReviewTransition + Before/After hook signatures compile +
 *     can be invoked
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { HookRegistry } from '../src/hooks/index.js'
import type {
  AfterReviewTransitionHook,
  BeforeReviewTransitionHook,
  HookHandler,
  HookPhase,
  ReviewTransition,
} from '../src/hooks/index.js'

describe('Cut 8 — review-lifecycle phase types', () => {
  it('HookPhase includes all 10 review phases', () => {
    const phases: HookPhase[] = [
      'beforeSubmitForReview',
      'afterSubmitForReview',
      'beforeApprove',
      'afterApprove',
      'beforeReject',
      'afterReject',
      'beforePublishRequest',
      'afterPublishRequest',
      'beforePublishApprove',
      'afterPublishApprove',
    ]
    // Type-level check — assertion compiles only when each name
    // is in the HookPhase union.
    expect(phases).toHaveLength(10)
  })

  it('HookHandler<P> re-narrows before* review phases to BeforeReviewTransitionHook', () => {
    expectTypeOf<HookHandler<'beforeSubmitForReview'>>().toEqualTypeOf<BeforeReviewTransitionHook>()
    expectTypeOf<HookHandler<'beforeApprove'>>().toEqualTypeOf<BeforeReviewTransitionHook>()
    expectTypeOf<HookHandler<'beforeReject'>>().toEqualTypeOf<BeforeReviewTransitionHook>()
    expectTypeOf<HookHandler<'beforePublishRequest'>>().toEqualTypeOf<BeforeReviewTransitionHook>()
    expectTypeOf<HookHandler<'beforePublishApprove'>>().toEqualTypeOf<BeforeReviewTransitionHook>()
  })

  it('HookHandler<P> re-narrows after* review phases to AfterReviewTransitionHook', () => {
    expectTypeOf<HookHandler<'afterSubmitForReview'>>().toEqualTypeOf<AfterReviewTransitionHook>()
    expectTypeOf<HookHandler<'afterApprove'>>().toEqualTypeOf<AfterReviewTransitionHook>()
    expectTypeOf<HookHandler<'afterReject'>>().toEqualTypeOf<AfterReviewTransitionHook>()
    expectTypeOf<HookHandler<'afterPublishRequest'>>().toEqualTypeOf<AfterReviewTransitionHook>()
    expectTypeOf<HookHandler<'afterPublishApprove'>>().toEqualTypeOf<AfterReviewTransitionHook>()
  })

  it('ReviewTransition carries scope + optional comment + optional target', () => {
    const t1: ReviewTransition = {
      scope: { kind: 'page', name: 'home' },
    }
    const t2: ReviewTransition = {
      scope: { kind: 'page', name: 'home' },
      comment: 'fix the typo on line 5',
    }
    const t3: ReviewTransition = {
      scope: { kind: 'page', name: 'home' },
      target: 'production',
    }
    expect(t1.scope.kind).toBe('page')
    expect(t2.comment).toBe('fix the typo on line 5')
    expect(t3.target).toBe('production')
  })

  it('BeforeReviewTransitionHook returns the (possibly mutated) transition', () => {
    const hook: BeforeReviewTransitionHook = async (transition, _ctx) => {
      // Hook may add an audit-trail comment, default a target,
      // etc. State machine consumes the returned transition.
      return { ...transition, comment: transition.comment ?? '(no reason given)' }
    }
    expect(typeof hook).toBe('function')
  })

  it('AfterReviewTransitionHook returns void (observational)', () => {
    const hook: AfterReviewTransitionHook = async (_transition, _ctx) => {
      // observe-only — log to external system, send notification, etc.
    }
    expect(typeof hook).toBe('function')
  })
})

describe('Cut 8 — HookRegistry accepts review-phase registrations', () => {
  it('registers handlers for every review phase', () => {
    const r = new HookRegistry()
    const beforeT: BeforeReviewTransitionHook = async t => t
    const afterT: AfterReviewTransitionHook = async () => {}
    r.register('beforeSubmitForReview', beforeT, { name: 'a' })
    r.register('afterSubmitForReview', afterT, { name: 'b' })
    r.register('beforeApprove', beforeT, { name: 'c' })
    r.register('afterApprove', afterT, { name: 'd' })
    r.register('beforeReject', beforeT, { name: 'e' })
    r.register('afterReject', afterT, { name: 'f' })
    r.register('beforePublishRequest', beforeT, { name: 'g' })
    r.register('afterPublishRequest', afterT, { name: 'h' })
    r.register('beforePublishApprove', beforeT, { name: 'i' })
    r.register('afterPublishApprove', afterT, { name: 'j' })
    expect(r.size('beforeSubmitForReview')).toBe(1)
    expect(r.size('afterSubmitForReview')).toBe(1)
    expect(r.size('beforeApprove')).toBe(1)
    expect(r.size('afterApprove')).toBe(1)
    expect(r.size('beforeReject')).toBe(1)
    expect(r.size('afterReject')).toBe(1)
    expect(r.size('beforePublishRequest')).toBe(1)
    expect(r.size('afterPublishRequest')).toBe(1)
    expect(r.size('beforePublishApprove')).toBe(1)
    expect(r.size('afterPublishApprove')).toBe(1)
    expect(r.size()).toBe(10)
  })

  it('priority + sealing semantics same as v1 phases', () => {
    const r = new HookRegistry()
    const handler: BeforeReviewTransitionHook = async t => t
    r.register('beforeApprove', handler, { name: 'high', priority: 50 })
    r.register('beforeApprove', handler, { name: 'low', priority: 1000 })
    const order = r.getByPhase('beforeApprove').map(reg => reg.name)
    expect(order).toEqual(['high', 'low'])

    r.seal()
    expect(() => r.register('beforeApprove', handler, { name: 'late' })).toThrow()
  })
})
