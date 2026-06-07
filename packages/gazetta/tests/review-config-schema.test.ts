/**
 * Cut 1 of review-workflow (#515): config schema (Zod) on target + site.
 *
 * Pure schema/types per design-review-workflow.md "Configuration" + the
 * locked invariants:
 *   - reviewWorkflowSchema: { enabled (default false), requiredApprovers
 *     (positive int, default 1), allowSelfApproval (default true),
 *     invalidateOnSave ('content-diff' | 'always', default 'content-diff') }
 *   - targetSchema extends with reviewWorkflow?, requiresPublishApproval?,
 *     requiredPublishApprovers? — the per-target publish-approval opt-in
 *     fields (the design's "per-target publish approval" invariant).
 *   - SiteConfigSchema gains site-level reviewWorkflow? (target inherits
 *     from site when target.reviewWorkflow is absent).
 *
 * No runtime behavior (state machine, sidecars, validators, audit) yet —
 * those land in subsequent cuts.
 */

import { describe, it, expect } from 'vitest'
import { SiteConfigSchema, reviewWorkflowSchema, targetSchema } from '../src/config/schemas.js'
import type { ReviewWorkflowConfig, SiteManifest, TargetConfig } from '../src/types.js'
import { resolveReviewWorkflowConfig } from '../src/types.js'

// Archetypes A-E from design-review-workflow.md "Workflow archetypes".
const ARCHETYPES: Array<{ name: string; config: Record<string, unknown> }> = [
  {
    name: 'A. Solo — review off, publish gate off',
    config: {
      name: 'main',
      targets: {
        local: { storage: { type: 'filesystem' } },
      },
    },
  },
  {
    name: 'B. Small team content focus — review on, publish gate off',
    config: {
      name: 'main',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 1,
        allowSelfApproval: true,
        invalidateOnSave: 'content-diff',
      },
      targets: {
        local: { storage: { type: 'filesystem' } },
        production: { storage: { type: 'r2', bucket: 'prod' } },
      },
    },
  },
  {
    name: 'C. Small team release focus — review off, publish gate on (prod only)',
    config: {
      name: 'main',
      targets: {
        local: { storage: { type: 'filesystem' } },
        production: {
          storage: { type: 'r2', bucket: 'prod' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    },
  },
  {
    name: 'D. Mid team — review on + publish gate on (prod only)',
    config: {
      name: 'main',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 1,
        allowSelfApproval: true,
        invalidateOnSave: 'content-diff',
      },
      targets: {
        local: { storage: { type: 'filesystem' } },
        production: {
          storage: { type: 'r2', bucket: 'prod' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    },
  },
  {
    name: 'E. Compliance — review w/ 2 approvers + no self-approval + always-invalidate + publish gate w/ 2 approvers',
    config: {
      name: 'main',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 2,
        allowSelfApproval: false,
        invalidateOnSave: 'always',
      },
      targets: {
        local: { storage: { type: 'filesystem' } },
        production: {
          storage: { type: 'r2', bucket: 'prod' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 2,
        },
      },
    },
  },
]

describe('reviewWorkflowSchema', () => {
  it('accepts the four-field shape with all fields set', () => {
    const result = reviewWorkflowSchema.safeParse({
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({
        enabled: true,
        requiredApprovers: 2,
        allowSelfApproval: false,
        invalidateOnSave: 'always',
      })
    }
  })

  it('applies defaults when fields are absent', () => {
    // Empty object — schema fills in every field from its default.
    const result = reviewWorkflowSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({
        enabled: false,
        requiredApprovers: 1,
        allowSelfApproval: true,
        invalidateOnSave: 'content-diff',
      })
    }
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

  it('rejects unknown fields (strict)', () => {
    const result = reviewWorkflowSchema.safeParse({ enabled: true, extraField: 'x' })
    expect(result.success).toBe(false)
  })
})

describe('SiteConfigSchema with site-level reviewWorkflow', () => {
  it.each(ARCHETYPES)('accepts archetype: $name', ({ config }) => {
    const result = SiteConfigSchema.safeParse(config)
    expect(result.success, JSON.stringify(result, null, 2)).toBe(true)
  })

  it('rejects site-level reviewWorkflow with requiredApprovers: 0', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, requiredApprovers: 0 },
    })
    expect(result.success).toBe(false)
  })

  it("rejects site-level reviewWorkflow with invalidateOnSave: 'unknown'", () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, invalidateOnSave: 'unknown' },
    })
    expect(result.success).toBe(false)
  })
})

describe('targetSchema (review-related target fields)', () => {
  it('accepts requiresPublishApproval + requiredPublishApprovers', () => {
    const result = targetSchema.safeParse({
      requiresPublishApproval: true,
      requiredPublishApprovers: 2,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a per-target reviewWorkflow override', () => {
    const result = targetSchema.safeParse({
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 2,
        allowSelfApproval: false,
        invalidateOnSave: 'always',
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects requiredPublishApprovers: 0', () => {
    const result = targetSchema.safeParse({
      requiresPublishApproval: true,
      requiredPublishApprovers: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-boolean requiresPublishApproval', () => {
    const result = targetSchema.safeParse({ requiresPublishApproval: 'yes' })
    expect(result.success).toBe(false)
  })

  it('accepts a target without any review fields (per-target opt-in)', () => {
    const result = targetSchema.safeParse({
      storage: { type: 'filesystem' },
    })
    expect(result.success).toBe(true)
  })
})

describe('resolveReviewWorkflowConfig — target inherits from site when unset', () => {
  it('returns undefined when neither site nor target sets reviewWorkflow', () => {
    const site: SiteManifest = { name: 'main' }
    const target: TargetConfig = { storage: stubStorage() }
    expect(resolveReviewWorkflowConfig(site, target)).toBeUndefined()
  })

  it('inherits site-level reviewWorkflow when target.reviewWorkflow is absent', () => {
    const siteCfg: ReviewWorkflowConfig = {
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    }
    const site: SiteManifest = { name: 'main', reviewWorkflow: siteCfg }
    const target: TargetConfig = { storage: stubStorage() }
    expect(resolveReviewWorkflowConfig(site, target)).toBe(siteCfg)
  })

  it('target.reviewWorkflow overrides site-level when present (atomic)', () => {
    const siteCfg: ReviewWorkflowConfig = {
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    }
    const targetCfg: ReviewWorkflowConfig = {
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    }
    const site: SiteManifest = { name: 'main', reviewWorkflow: siteCfg }
    const target: TargetConfig = { storage: stubStorage(), reviewWorkflow: targetCfg }
    expect(resolveReviewWorkflowConfig(site, target)).toBe(targetCfg)
  })

  it('returns target.reviewWorkflow even when site has none', () => {
    const targetCfg: ReviewWorkflowConfig = {
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    }
    const site: SiteManifest = { name: 'main' }
    const target: TargetConfig = { storage: stubStorage(), reviewWorkflow: targetCfg }
    expect(resolveReviewWorkflowConfig(site, target)).toBe(targetCfg)
  })
})

// Stub storage provider — never invoked in these schema/resolver tests; only
// needed to satisfy the TargetConfig structural type.
function stubStorage() {
  return {
    readFile: async () => '',
    readDir: async () => [],
    exists: async () => false,
    writeFile: async () => {},
    mkdir: async () => {},
    rm: async () => {},
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    readStream: async () => new ReadableStream<Uint8Array>(),
    writeStream: async () => {},
  } as TargetConfig['storage']
}
