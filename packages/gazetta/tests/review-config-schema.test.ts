/**
 * Cut 1 of review-workflow (#515): reviewWorkflow config schema.
 *
 * Tests pin the design-review-workflow.md "Configuration" contract:
 *   - reviewWorkflowSchema validates {enabled, requiredApprovers,
 *     allowSelfApproval, invalidateOnSave} with the documented defaults
 *     and the locked invariants (requiredApprovers > 0; invalidateOnSave
 *     is a closed enum).
 *   - SiteConfigSchema accepts a site-level `reviewWorkflow:` block.
 *   - The target shape accepts `reviewWorkflow`, `requiresPublishApproval`,
 *     and `requiredPublishApprovers` fields.
 *   - The five workflow archetypes A–E from the design doc are accepted by
 *     SiteConfigSchema end-to-end.
 *   - `resolveReviewWorkflow(target, site)` honors target → site
 *     inheritance: a target without its own block inherits the site-level
 *     config; a target with its own block wins.
 *
 * Acceptance criteria (per cut sub-issue #515):
 *   - Schema accepts archetypes A–E from the design doc.
 *   - Rejects `requiredApprovers: 0`, `invalidateOnSave: 'unknown'`.
 *   - Target without `reviewWorkflow` inherits the site-level config.
 */

import { describe, it, expect } from 'vitest'
import { SiteConfigSchema, reviewWorkflowSchema } from '../src/config/schemas.js'
import { resolveReviewWorkflow } from '../src/types.js'
import type { ReviewWorkflowConfig, SiteManifest, TargetConfig } from '../src/types.js'
import { filesystemStorage } from '../src/providers/factories.js'

describe('reviewWorkflowSchema', () => {
  it('accepts empty block and applies documented defaults', () => {
    const result = reviewWorkflowSchema.parse({})
    expect(result.enabled).toBe(false)
    expect(result.requiredApprovers).toBe(1)
    expect(result.allowSelfApproval).toBe(true)
    expect(result.invalidateOnSave).toBe('content-diff')
  })

  it('accepts a fully specified block', () => {
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

  it('rejects requiredApprovers: 0 (must be > 0)', () => {
    const r = reviewWorkflowSchema.safeParse({ requiredApprovers: 0 })
    expect(r.success).toBe(false)
  })

  it('rejects negative requiredApprovers', () => {
    const r = reviewWorkflowSchema.safeParse({ requiredApprovers: -1 })
    expect(r.success).toBe(false)
  })

  it('rejects non-integer requiredApprovers', () => {
    const r = reviewWorkflowSchema.safeParse({ requiredApprovers: 1.5 })
    expect(r.success).toBe(false)
  })

  it("rejects invalidateOnSave: 'unknown' (closed enum)", () => {
    const r = reviewWorkflowSchema.safeParse({ invalidateOnSave: 'unknown' })
    expect(r.success).toBe(false)
  })

  it('rejects unknown fields (closed shape)', () => {
    const r = reviewWorkflowSchema.safeParse({ unknownField: 'x' })
    expect(r.success).toBe(false)
  })
})

describe('SiteConfigSchema accepts reviewWorkflow at site + target levels', () => {
  it('accepts a site-level reviewWorkflow block', () => {
    const r = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 1,
        allowSelfApproval: true,
        invalidateOnSave: 'content-diff',
      },
    })
    expect(r.success).toBe(true)
  })

  it('accepts per-target reviewWorkflow + requiresPublishApproval + requiredPublishApprovers', () => {
    const r = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        production: {
          reviewWorkflow: {
            enabled: true,
            requiredApprovers: 2,
            allowSelfApproval: false,
            invalidateOnSave: 'always',
          },
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    })
    expect(r.success).toBe(true)
  })
})

describe('SiteConfigSchema accepts the five workflow archetypes', () => {
  it('Archetype A — Solo: review off, publish gate off', () => {
    const r = SiteConfigSchema.safeParse({
      name: 'solo-blog',
      targets: {
        local: {},
        production: {},
      },
    })
    expect(r.success).toBe(true)
  })

  it('Archetype B — Small team, content focus: review on, publish gate off', () => {
    const r = SiteConfigSchema.safeParse({
      name: 'small-team-content',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 1,
        allowSelfApproval: true,
        invalidateOnSave: 'content-diff',
      },
      targets: {
        local: {},
        production: {},
      },
    })
    expect(r.success).toBe(true)
  })

  it('Archetype C — Small team, release focus: review off, publish gate on (prod)', () => {
    const r = SiteConfigSchema.safeParse({
      name: 'small-team-release',
      targets: {
        local: {},
        production: {
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    })
    expect(r.success).toBe(true)
  })

  it('Archetype D — Mid team, both: review on + publish gate on (prod)', () => {
    const r = SiteConfigSchema.safeParse({
      name: 'mid-team',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 1,
        allowSelfApproval: true,
        invalidateOnSave: 'content-diff',
      },
      targets: {
        local: {},
        staging: {},
        production: {
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    })
    expect(r.success).toBe(true)
  })

  it('Archetype E — Compliance: 2 approvers + no self-approval + publish gate', () => {
    const r = SiteConfigSchema.safeParse({
      name: 'compliance',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 2,
        allowSelfApproval: false,
        invalidateOnSave: 'always',
      },
      targets: {
        production: {
          requiresPublishApproval: true,
          requiredPublishApprovers: 2,
        },
      },
    })
    expect(r.success).toBe(true)
  })
})

describe('resolveReviewWorkflow site → target inheritance', () => {
  const site: SiteManifest = {
    name: 'main',
    reviewWorkflow: {
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    },
  }

  it('target without reviewWorkflow inherits the site-level config', () => {
    const target: TargetConfig = { storage: filesystemStorage({ path: './dist/local' }) }
    const resolved = resolveReviewWorkflow(target, site)
    expect(resolved).toEqual(site.reviewWorkflow)
  })

  it('target with its own reviewWorkflow wins over site', () => {
    const targetCfg: ReviewWorkflowConfig = {
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    }
    const target: TargetConfig = {
      storage: filesystemStorage({ path: './dist/prod' }),
      reviewWorkflow: targetCfg,
    }
    const resolved = resolveReviewWorkflow(target, site)
    expect(resolved).toEqual(targetCfg)
  })

  it('returns undefined when neither site nor target sets reviewWorkflow', () => {
    const bareSite: SiteManifest = { name: 'solo' }
    const target: TargetConfig = { storage: filesystemStorage({ path: './dist/local' }) }
    const resolved = resolveReviewWorkflow(target, bareSite)
    expect(resolved).toBeUndefined()
  })
})
