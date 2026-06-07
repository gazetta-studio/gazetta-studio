/**
 * Cut 1 tests for review-workflow: `reviewWorkflowSchema` (Zod) +
 * `ReviewWorkflowConfig` (TS) + per-target `requiresPublishApproval` /
 * `requiredPublishApprovers` + site-level inheritance.
 *
 * Per `design-review-workflow.md`:
 *   - Five archetypes A–E must parse cleanly under SiteConfigSchema
 *   - Invalid values rejected: `requiredApprovers: 0`,
 *     `invalidateOnSave: 'unknown'`, negative / non-integer approvers
 *   - Target without `reviewWorkflow` inherits the site-level config
 *     (per-field via `resolveReviewWorkflow`)
 *
 * Pure schema/types/data — no runtime behavior beyond the resolver
 * helper (a pure function over `(site, target)`).
 *
 * Pins the contract that downstream cuts (state machine, save handler,
 * audit) read against. Reverting the impl re-fails these tests by
 * design.
 */

import { describe, expect, it } from 'vitest'
import { reviewWorkflowSchema, SiteConfigSchema } from '../src/config/schemas.js'
import { resolveReviewWorkflow } from '../src/review/config.js'
import type { ReviewWorkflowConfig, SiteManifest, TargetConfig } from '../src/types.js'

describe('reviewWorkflowSchema — field shape + defaults', () => {
  it('accepts {} and applies all four defaults', () => {
    const result = reviewWorkflowSchema.parse({})
    expect(result).toEqual({
      enabled: false,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    })
  })

  it('accepts fully-specified config (archetype E values)', () => {
    const result = reviewWorkflowSchema.parse({
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    })
    expect(result).toEqual({
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    })
  })

  it('rejects requiredApprovers: 0', () => {
    const result = reviewWorkflowSchema.safeParse({ requiredApprovers: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects negative requiredApprovers', () => {
    const result = reviewWorkflowSchema.safeParse({ requiredApprovers: -1 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer requiredApprovers', () => {
    const result = reviewWorkflowSchema.safeParse({ requiredApprovers: 1.5 })
    expect(result.success).toBe(false)
  })

  it("rejects invalidateOnSave: 'unknown'", () => {
    const result = reviewWorkflowSchema.safeParse({ invalidateOnSave: 'unknown' })
    expect(result.success).toBe(false)
  })

  it('rejects unknown fields (strict — forward-compat changes must extend the schema)', () => {
    const result = reviewWorkflowSchema.safeParse({ futureField: 'x' })
    expect(result.success).toBe(false)
  })
})

describe('SiteConfigSchema accepts archetypes A–E', () => {
  it('archetype A — Solo: no reviewWorkflow, no publish gate', () => {
    const result = SiteConfigSchema.safeParse({ name: 'main' })
    expect(result.success).toBe(true)
  })

  it('archetype B — Small team, content focus: review on, publish gate off', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, requiredApprovers: 1, allowSelfApproval: true },
    })
    expect(result.success).toBe(true)
  })

  it('archetype C — Small team, release focus: review off, publish gate on prod only', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        local: { storage: { type: 'filesystem' } },
        production: {
          storage: { type: 'r2', bucket: 'site' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('archetype D — Mid team: review on + publish gate on prod only', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, requiredApprovers: 1, allowSelfApproval: true },
      targets: {
        local: { storage: { type: 'filesystem' } },
        production: {
          storage: { type: 'r2', bucket: 'site' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('archetype E — Compliance: 2 approvers, no self-approval, always-invalidate, double publish gate', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 2,
        allowSelfApproval: false,
        invalidateOnSave: 'always',
      },
      targets: {
        production: {
          storage: { type: 'r2', bucket: 'site' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 2,
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects bad reviewWorkflow on site (e.g. requiredApprovers: 0) at the site level', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, requiredApprovers: 0 },
    })
    expect(result.success).toBe(false)
  })
})

describe('resolveReviewWorkflow — site → target inheritance', () => {
  function mkSite(reviewWorkflow?: ReviewWorkflowConfig): SiteManifest {
    return { name: 'main', reviewWorkflow }
  }

  function mkTarget(reviewWorkflow?: ReviewWorkflowConfig): TargetConfig {
    // Stub storage — resolver doesn't touch it.
    return {
      storage: {} as TargetConfig['storage'],
      reviewWorkflow,
    }
  }

  it('returns null when no reviewWorkflow at site or target (archetype A)', () => {
    expect(resolveReviewWorkflow(mkSite(), mkTarget())).toBeNull()
  })

  it('target without reviewWorkflow inherits site-level config (archetype B / D / E)', () => {
    const siteRW: ReviewWorkflowConfig = {
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    }
    expect(resolveReviewWorkflow(mkSite(siteRW), mkTarget())).toEqual(siteRW)
  })

  it('target-level config overrides site per-field; absent target fields fall through', () => {
    const siteRW: ReviewWorkflowConfig = {
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    }
    // Target overrides only `requiredApprovers`; other three fields inherit.
    const targetRW: Partial<ReviewWorkflowConfig> = { requiredApprovers: 3 }
    expect(resolveReviewWorkflow(mkSite(siteRW), mkTarget(targetRW as ReviewWorkflowConfig))).toEqual({
      enabled: true,
      requiredApprovers: 3,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    })
  })

  it('target-only config (site has no reviewWorkflow) returns the target config with hardcoded defaults', () => {
    const targetRW: Partial<ReviewWorkflowConfig> = { enabled: true }
    expect(resolveReviewWorkflow(mkSite(), mkTarget(targetRW as ReviewWorkflowConfig))).toEqual({
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    })
  })

  it('target explicit `enabled: false` overrides site `enabled: true`', () => {
    const siteRW: ReviewWorkflowConfig = {
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    }
    const targetRW: Partial<ReviewWorkflowConfig> = { enabled: false }
    const resolved = resolveReviewWorkflow(mkSite(siteRW), mkTarget(targetRW as ReviewWorkflowConfig))
    expect(resolved?.enabled).toBe(false)
  })
})
