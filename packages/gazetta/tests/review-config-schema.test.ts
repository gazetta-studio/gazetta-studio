/**
 * Cut 1 of `design-review-workflow.md`: review-workflow config schema (Zod)
 * on target + site, plus the inheritance resolver.
 *
 * Three concerns covered:
 *   1. `reviewWorkflowSchema` accepts archetype A–E configurations from the
 *      design doc (and applies sensible field defaults when sub-fields are
 *      omitted).
 *   2. The schema rejects structurally meaningless values (`requiredApprovers:
 *      0`, `invalidateOnSave: 'unknown'`) so bad operator config fails at site
 *      load, not at first review attempt.
 *   3. `resolveReviewWorkflow(target, site)` returns the wholesale override
 *      when the target sets a block, the site value when the target doesn't,
 *      and undefined when neither sets a value (archetype A — review off).
 *
 * `requiresPublishApproval` / `requiredPublishApprovers` on TargetConfig are
 * TS-typed but not Zod-validated at the SiteConfigSchema level (targets are
 * loose-validated there to keep the schema stable across foundation
 * additions; bad shapes fail at TS edit time via the interface). They appear
 * in the inheritance + acceptance tests purely as part of the archetype
 * shapes operators write, not as schema parse subjects.
 */
import { describe, expect, it } from 'vitest'
import { reviewWorkflowSchema } from '../src/config/index.js'
import { SiteConfigSchema } from '../src/config/index.js'
import type { ReviewWorkflowConfig, SiteManifest, TargetConfig } from '../src/types.js'
import { resolveReviewWorkflow } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function target(overrides: Partial<TargetConfig> = {}): TargetConfig {
  return { storage: memoryStorage(), ...overrides }
}

function site(overrides: Partial<SiteManifest> = {}): SiteManifest {
  return { name: 'test', ...overrides }
}

describe('reviewWorkflowSchema — archetype acceptance', () => {
  it('A (solo): site-level reviewWorkflow absent is valid', () => {
    // Archetype A doesn't set reviewWorkflow at all. The schema isn't
    // exercised; site config validates without it via SiteConfigSchema.
    const result = SiteConfigSchema.safeParse({ name: 'solo' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.reviewWorkflow).toBeUndefined()
  })

  it('B (content focus): site-level reviewWorkflow on, defaults fill in', () => {
    const parsed = reviewWorkflowSchema.parse({ enabled: true })
    expect(parsed).toEqual({
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    })
  })

  it('B (content focus): full explicit block parses unchanged', () => {
    const block = {
      enabled: true,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff' as const,
    }
    expect(reviewWorkflowSchema.parse(block)).toEqual(block)
  })

  it('C (release focus): no reviewWorkflow, just publish-approval — schema not invoked', () => {
    // Archetype C sets `requiresPublishApproval: true` per-target without any
    // reviewWorkflow. The schema's job is to validate reviewWorkflow blocks;
    // C's site config doesn't include one, so the schema isn't exercised here.
    // The publish-approval fields are TS-typed on TargetConfig and inherit no
    // schema gate at the site level. We assert that the configuration shape
    // type-checks (no runtime error) by constructing it.
    const t = target({ requiresPublishApproval: true, requiredPublishApprovers: 1 })
    expect(t.requiresPublishApproval).toBe(true)
    expect(t.requiredPublishApprovers).toBe(1)
  })

  it('D (mid team — both): site reviewWorkflow on + target-level publish-approval gate', () => {
    const siteBlock = reviewWorkflowSchema.parse({ enabled: true, requiredApprovers: 1 })
    expect(siteBlock.enabled).toBe(true)
    // Production target shape (publish-approval fields are TS-typed; not
    // gated by reviewWorkflowSchema since they belong on TargetConfig, not
    // inside a reviewWorkflow block).
    const prod = target({
      requiresPublishApproval: true,
      requiredPublishApprovers: 1,
    })
    expect(prod.requiresPublishApproval).toBe(true)
  })

  it('E (compliance): site-level 4-eyes with no-self-approval + invalidateOnSave always', () => {
    const block = reviewWorkflowSchema.parse({
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    })
    expect(block).toEqual({
      enabled: true,
      requiredApprovers: 2,
      allowSelfApproval: false,
      invalidateOnSave: 'always',
    })
  })

  it('E (compliance): per-target publish-approval gate with 2 approvers', () => {
    const prod = target({
      requiresPublishApproval: true,
      requiredPublishApprovers: 2,
    })
    expect(prod.requiresPublishApproval).toBe(true)
    expect(prod.requiredPublishApprovers).toBe(2)
  })

  it('empty {} parses to the all-defaults configuration', () => {
    expect(reviewWorkflowSchema.parse({})).toEqual({
      enabled: false,
      requiredApprovers: 1,
      allowSelfApproval: true,
      invalidateOnSave: 'content-diff',
    })
  })
})

describe('reviewWorkflowSchema — invalid input rejection', () => {
  it('rejects requiredApprovers: 0', () => {
    expect(() => reviewWorkflowSchema.parse({ requiredApprovers: 0 })).toThrow()
  })

  it('rejects negative requiredApprovers', () => {
    expect(() => reviewWorkflowSchema.parse({ requiredApprovers: -1 })).toThrow()
  })

  it('rejects non-integer requiredApprovers', () => {
    expect(() => reviewWorkflowSchema.parse({ requiredApprovers: 1.5 })).toThrow()
  })

  it("rejects invalidateOnSave: 'unknown'", () => {
    expect(() => reviewWorkflowSchema.parse({ invalidateOnSave: 'unknown' })).toThrow()
  })

  it("rejects invalidateOnSave: ''", () => {
    expect(() => reviewWorkflowSchema.parse({ invalidateOnSave: '' })).toThrow()
  })

  it('rejects non-boolean enabled', () => {
    expect(() => reviewWorkflowSchema.parse({ enabled: 'yes' })).toThrow()
  })

  it('rejects unknown sub-fields (strict mode prevents typos)', () => {
    // Strict mode catches a typo like `requireApprovers` (missing 'd') before
    // it silently becomes a no-op at runtime.
    expect(() => reviewWorkflowSchema.parse({ enabled: true, requireApprovers: 2 })).toThrow()
  })
})

describe('SiteConfigSchema — site-level reviewWorkflow integration', () => {
  it('accepts a site config with reviewWorkflow', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'compliance-site',
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 2,
        allowSelfApproval: false,
        invalidateOnSave: 'always',
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reviewWorkflow?.requiredApprovers).toBe(2)
      expect(result.data.reviewWorkflow?.allowSelfApproval).toBe(false)
    }
  })

  it('rejects a site config with a structurally bad reviewWorkflow', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'bad-site',
      reviewWorkflow: { requiredApprovers: 0 },
    })
    expect(result.success).toBe(false)
  })
})

describe('resolveReviewWorkflow — inheritance', () => {
  const SITE_BLOCK: ReviewWorkflowConfig = {
    enabled: true,
    requiredApprovers: 1,
    allowSelfApproval: true,
    invalidateOnSave: 'content-diff',
  }

  const TARGET_BLOCK: ReviewWorkflowConfig = {
    enabled: true,
    requiredApprovers: 2,
    allowSelfApproval: false,
    invalidateOnSave: 'always',
  }

  it('returns the site block when target has no reviewWorkflow', () => {
    const resolved = resolveReviewWorkflow(target(), site({ reviewWorkflow: SITE_BLOCK }))
    expect(resolved).toBe(SITE_BLOCK)
  })

  it('returns the target block wholesale when target sets reviewWorkflow', () => {
    const resolved = resolveReviewWorkflow(
      target({ reviewWorkflow: TARGET_BLOCK }),
      site({ reviewWorkflow: SITE_BLOCK }),
    )
    expect(resolved).toBe(TARGET_BLOCK)
  })

  it('returns undefined when neither sets reviewWorkflow (archetype A — solo)', () => {
    expect(resolveReviewWorkflow(target(), site())).toBeUndefined()
  })

  it('returns the target block when only target sets it (site default off)', () => {
    const resolved = resolveReviewWorkflow(target({ reviewWorkflow: TARGET_BLOCK }), site())
    expect(resolved).toBe(TARGET_BLOCK)
  })

  it('does not per-field merge — target block fully shadows site block', () => {
    // Even when the target block sets only `enabled`, the entire site block
    // is shadowed. Operators wanting partial overrides write the full block
    // explicitly. Locked per `design-review-workflow.md` "Configuration".
    const partialTarget: ReviewWorkflowConfig = { enabled: true }
    const resolved = resolveReviewWorkflow(
      target({ reviewWorkflow: partialTarget }),
      site({ reviewWorkflow: SITE_BLOCK }),
    )
    expect(resolved).toBe(partialTarget)
    // Critically: requiredApprovers is NOT inherited from the site block.
    // The target block carries only what the operator wrote.
    expect(resolved?.requiredApprovers).toBeUndefined()
  })
})
