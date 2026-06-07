/**
 * Review-workflow config schema tests (Cut 1 of design-review-workflow.md).
 *
 * Locked invariants this pins (from the design doc):
 *   - `enabled` defaults off; turn on per-site or per-target
 *   - `requiredApprovers` is a positive integer
 *   - `allowSelfApproval` defaults true; compliance archetype opts out
 *   - `invalidateOnSave` is the closed enum `'content-diff' | 'always'`
 *   - Per-target `requiresPublishApproval` + `requiredPublishApprovers`
 *     gate publish events independently of content review
 *   - Both site-level and target-level reviewWorkflow blocks are accepted;
 *     the runtime resolves the fallback chain (out of scope for Cut 1)
 */

import { describe, expect, it } from 'vitest'
import { ReviewWorkflowConfigSchema, SiteConfigSchema } from '../src/config/schemas.js'

describe('ReviewWorkflowConfigSchema (standalone)', () => {
  it('accepts the empty block (every field optional; runtime applies defaults)', () => {
    const result = ReviewWorkflowConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts the full block with every field set', () => {
    const result = ReviewWorkflowConfigSchema.safeParse({
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    })
    expect(result.success).toBe(true)
  })

  it('rejects requiredApprovers: 0 (must be positive)', () => {
    const result = ReviewWorkflowConfigSchema.safeParse({ requiredApprovers: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects negative requiredApprovers', () => {
    const result = ReviewWorkflowConfigSchema.safeParse({ requiredApprovers: -1 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer requiredApprovers', () => {
    const result = ReviewWorkflowConfigSchema.safeParse({ requiredApprovers: 1.5 })
    expect(result.success).toBe(false)
  })

  it("rejects invalidateOnSave: 'unknown' (closed enum)", () => {
    const result = ReviewWorkflowConfigSchema.safeParse({ invalidateOnSave: 'unknown' })
    expect(result.success).toBe(false)
  })

  it("accepts invalidateOnSave: 'content-diff'", () => {
    const result = ReviewWorkflowConfigSchema.safeParse({ invalidateOnSave: 'content-diff' })
    expect(result.success).toBe(true)
  })

  it("accepts invalidateOnSave: 'always'", () => {
    const result = ReviewWorkflowConfigSchema.safeParse({ invalidateOnSave: 'always' })
    expect(result.success).toBe(true)
  })

  it("rejects enabled: 'true' (must be boolean)", () => {
    const result = ReviewWorkflowConfigSchema.safeParse({ enabled: 'true' })
    expect(result.success).toBe(false)
  })

  it("rejects allowSelfApproval: 'no' (must be boolean)", () => {
    const result = ReviewWorkflowConfigSchema.safeParse({ allowSelfApproval: 'no' })
    expect(result.success).toBe(false)
  })

  it('rejects unknown fields (strict — catches typos like requiredAprovers)', () => {
    const result = ReviewWorkflowConfigSchema.safeParse({
      enabled: true,
      requiredAprovers: 2, // typo, missing 'p'
    })
    expect(result.success).toBe(false)
  })
})

describe('SiteConfigSchema — archetypes A–E (design-review-workflow.md)', () => {
  // Archetype A: Solo — review off, publish gate off; one actor does everything
  it('archetype A (Solo): no reviewWorkflow anywhere parses cleanly', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'solo-site',
      targets: {
        production: { storage: { type: 'r2', bucket: 'site' } },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reviewWorkflow).toBeUndefined()
      expect(result.data.targets?.production?.reviewWorkflow).toBeUndefined()
      expect(result.data.targets?.production?.requiresPublishApproval).toBeUndefined()
    }
  })

  // Archetype B: Small team — content focus — review on, publish gate off
  it('archetype B (Small team — content focus): site-level reviewWorkflow.enabled=true', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'content-team',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 1,
        allowSelfApproval: true,
        invalidateOnSave: 'content-diff',
      },
      targets: {
        production: { storage: { type: 'r2', bucket: 'site' } },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reviewWorkflow?.enabled).toBe(true)
      expect(result.data.targets?.production?.requiresPublishApproval).toBeUndefined()
    }
  })

  // Archetype C: Small team — release focus — review off, publish gate on (prod only)
  it('archetype C (Small team — release focus): target-level requiresPublishApproval=true on prod', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'release-team',
      targets: {
        staging: { storage: { type: 'r2', bucket: 'staging' } },
        production: {
          storage: { type: 'r2', bucket: 'site' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reviewWorkflow).toBeUndefined()
      expect(result.data.targets?.production?.requiresPublishApproval).toBe(true)
      expect(result.data.targets?.production?.requiredPublishApprovers).toBe(1)
      expect(result.data.targets?.staging?.requiresPublishApproval).toBeUndefined()
    }
  })

  // Archetype D: Mid team — both — review on + publish gate on (prod only)
  it('archetype D (Mid team): site reviewWorkflow + target requiresPublishApproval', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'mid-team',
      reviewWorkflow: { enabled: true, requiredApprovers: 1 },
      targets: {
        staging: { storage: { type: 'r2', bucket: 'staging' } },
        production: {
          storage: { type: 'r2', bucket: 'site' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 1,
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reviewWorkflow?.enabled).toBe(true)
      expect(result.data.targets?.production?.requiresPublishApproval).toBe(true)
    }
  })

  // Archetype E: Compliance — review on with requiredApprovers: 2,
  // allowSelfApproval: false, publish gate on with requiredPublishApprovers: 2
  it('archetype E (Compliance): strict 4-eyes principle on both content + publish', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'compliance-site',
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
    if (result.success) {
      expect(result.data.reviewWorkflow?.requiredApprovers).toBe(2)
      expect(result.data.reviewWorkflow?.allowSelfApproval).toBe(false)
      expect(result.data.reviewWorkflow?.invalidateOnSave).toBe('always')
      expect(result.data.targets?.production?.requiredPublishApprovers).toBe(2)
    }
  })
})

describe('SiteConfigSchema — invalid review-workflow combinations', () => {
  it('rejects site-level reviewWorkflow.requiredApprovers: 0', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, requiredApprovers: 0 },
    })
    expect(result.success).toBe(false)
  })

  it("rejects site-level reviewWorkflow.invalidateOnSave: 'unknown'", () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { invalidateOnSave: 'unknown' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects target-level reviewWorkflow.requiredApprovers: 0', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        production: {
          storage: { type: 'r2', bucket: 'site' },
          reviewWorkflow: { requiredApprovers: 0 },
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects target-level requiredPublishApprovers: 0', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        production: {
          storage: { type: 'r2', bucket: 'site' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 0,
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects target-level requiresPublishApproval: 'yes' (must be boolean)", () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        production: {
          storage: { type: 'r2', bucket: 'site' },
          requiresPublishApproval: 'yes',
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects target-level requiredPublishApprovers: 1.5 (must be integer)', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        production: {
          storage: { type: 'r2', bucket: 'site' },
          requiresPublishApproval: true,
          requiredPublishApprovers: 1.5,
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown field inside reviewWorkflow (strict catches typo)', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, requireAprovers: 2 },
    })
    expect(result.success).toBe(false)
  })
})

describe('SiteConfigSchema — site → target inheritance shape', () => {
  // Cut 1 is "pure schema/types; no runtime behavior." The schema accepts
  // both site- and target-level reviewWorkflow without merging — the
  // runtime resolves the fallback chain (target > site) at use time.
  // These tests pin the SHAPE that future runtime work consumes.

  it('preserves site-level reviewWorkflow when target has none (runtime falls back to site)', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, requiredApprovers: 1 },
      targets: {
        production: { storage: { type: 'r2', bucket: 'site' } },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reviewWorkflow).toEqual({
        enabled: true,
        requiredApprovers: 1,
      })
      // Target reviewWorkflow ABSENT — runtime will read site-level
      expect(result.data.targets?.production?.reviewWorkflow).toBeUndefined()
    }
  })

  it('preserves BOTH site- and target-level reviewWorkflow without merging at schema layer', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      reviewWorkflow: { enabled: true, requiredApprovers: 1 },
      targets: {
        production: {
          storage: { type: 'r2', bucket: 'site' },
          reviewWorkflow: { requiredApprovers: 2, allowSelfApproval: false },
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reviewWorkflow?.requiredApprovers).toBe(1)
      // Target's reviewWorkflow stands beside site's — runtime picks
      // the most-specific value per-field. Schema does NOT merge.
      expect(result.data.targets?.production?.reviewWorkflow?.requiredApprovers).toBe(2)
      expect(result.data.targets?.production?.reviewWorkflow?.allowSelfApproval).toBe(false)
      expect(result.data.targets?.production?.reviewWorkflow?.enabled).toBeUndefined()
    }
  })

  it('accepts target-only reviewWorkflow (no site-level fallback needed)', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        production: {
          storage: { type: 'r2', bucket: 'site' },
          reviewWorkflow: { enabled: true, requiredApprovers: 2 },
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reviewWorkflow).toBeUndefined()
      expect(result.data.targets?.production?.reviewWorkflow?.requiredApprovers).toBe(2)
    }
  })

  it('preserves other target fields (storage, transforms) through the tightened target schema', () => {
    // The targets record carries known typed fields (reviewWorkflow,
    // requiresPublishApproval, requiredPublishApprovers) AND passes
    // through every other field (storage, transforms, environment, etc.)
    // unchanged for downstream provider validation.
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        production: {
          storage: { type: 'r2', bucket: 'site' },
          environment: 'production',
          siteUrl: 'https://example.com',
          requiresPublishApproval: true,
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const target = result.data.targets?.production as Record<string, unknown> | undefined
      expect(target?.storage).toEqual({ type: 'r2', bucket: 'site' })
      expect(target?.environment).toBe('production')
      expect(target?.siteUrl).toBe('https://example.com')
      expect(target?.requiresPublishApproval).toBe(true)
    }
  })
})
