/**
 * Type contract tests for the DeployAdapter Pattern 1 Provider surface.
 *
 * Cut 1 of the deploy contract — these tests pin the shape of the
 * interface, capability extension, error taxonomy, and TargetConfig
 * integration. They run as type-system assertions; no runtime
 * behavior is exercised.
 *
 * Reference: `.claude/rules/design-deploy.md` "The contract" section.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type {
  DeployAdapter,
  DeployContext,
  DeployLogger,
  DeployResult,
  ValidateContext,
  WorkerCapableDeployAdapter,
  WorkerRuntimeConfig,
} from '../src/deploy/types.js'
import {
  DeployAuthError,
  DeployConfigError,
  DeployContentError,
  DeployError,
  DeployTransportError,
} from '../src/deploy/errors.js'
import type { Issue } from '../src/validation/types.js'
import type { StorageProvider, TargetConfig, TargetType } from '../src/types.js'

describe('DeployAdapter interface shape', () => {
  it('declares name, supports, execute, optional validate', () => {
    expectTypeOf<DeployAdapter['name']>().toEqualTypeOf<string>()
    expectTypeOf<DeployAdapter['supports']>().toEqualTypeOf<readonly TargetType[]>()
    expectTypeOf<DeployAdapter['execute']>().toEqualTypeOf<(ctx: DeployContext) => Promise<DeployResult>>()
    expectTypeOf<DeployAdapter['validate']>().toEqualTypeOf<((ctx: ValidateContext) => Issue[]) | undefined>()
  })

  it('validate? returns the validation framework Issue[] shape', () => {
    // Per Q2 lock: validate? returns Issue[] from design-validation.md,
    // not a thinner string[]. Same taxonomy as other validators.
    type ValidateReturn = NonNullable<DeployAdapter['validate']> extends (ctx: ValidateContext) => infer R ? R : never
    expectTypeOf<ValidateReturn>().toEqualTypeOf<Issue[]>()
  })
})

describe('WorkerCapableDeployAdapter capability extension', () => {
  it('extends DeployAdapter (LSP — substitutable wherever the base is expected)', () => {
    expectTypeOf<WorkerCapableDeployAdapter>().toMatchTypeOf<DeployAdapter>()
  })

  it('adds workerRuntimeConfig() method', () => {
    expectTypeOf<WorkerCapableDeployAdapter['workerRuntimeConfig']>().toEqualTypeOf<() => WorkerRuntimeConfig>()
  })

  it('WorkerRuntimeConfig carries bucketBinding + optional routes + optional bindings', () => {
    expectTypeOf<WorkerRuntimeConfig['bucketBinding']>().toEqualTypeOf<string>()
    expectTypeOf<WorkerRuntimeConfig['routes']>().toEqualTypeOf<
      readonly { pattern: string; zone?: string }[] | undefined
    >()
    expectTypeOf<WorkerRuntimeConfig['bindings']>().toEqualTypeOf<Record<string, unknown> | undefined>()
  })
})

describe('DeployContext shape', () => {
  it('carries target, targetName, outputDir, storage, env, signal, logger', () => {
    expectTypeOf<DeployContext['target']>().toEqualTypeOf<TargetConfig>()
    expectTypeOf<DeployContext['targetName']>().toEqualTypeOf<string>()
    expectTypeOf<DeployContext['outputDir']>().toEqualTypeOf<string>()
    expectTypeOf<DeployContext['env']>().toEqualTypeOf<Record<string, string | undefined>>()
    expectTypeOf<DeployContext['signal']>().toEqualTypeOf<AbortSignal>()
    expectTypeOf<DeployContext['storage']>().toEqualTypeOf<StorageProvider>()
  })

  it('carries a DeployLogger matching the design-logging.md interface', () => {
    // Mirrors HookLogger's shape — `(obj | string, msg?)` per level.
    // No `trace`; deploy is operator-tier, info-and-up sufficient.
    expectTypeOf<DeployContext['logger']>().toEqualTypeOf<DeployLogger>()
  })
})

describe('ValidateContext shape', () => {
  it('carries target + targetName (no signal, no env — pre-flight validation is pure)', () => {
    expectTypeOf<ValidateContext['target']>().toEqualTypeOf<TargetConfig>()
    expectTypeOf<ValidateContext['targetName']>().toEqualTypeOf<string>()
  })
})

describe('DeployResult shape', () => {
  it('returns optional url + optional details record', () => {
    expectTypeOf<DeployResult['url']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<DeployResult['details']>().toEqualTypeOf<Record<string, unknown> | undefined>()
  })
})

describe('Error taxonomy', () => {
  it('DeployError is the base; all variants extend it', () => {
    // LSP: every subclass instance is substitutable for DeployError
    const auth: DeployError = new DeployAuthError('test', 'cloudflare-workers')
    const config: DeployError = new DeployConfigError('test', 'cloudflare-workers')
    const content: DeployError = new DeployContentError('test', 'cloudflare-workers')
    const transport: DeployError = new DeployTransportError('test', 'cloudflare-workers')
    expectTypeOf(auth).toMatchTypeOf<DeployError>()
    expectTypeOf(config).toMatchTypeOf<DeployError>()
    expectTypeOf(content).toMatchTypeOf<DeployError>()
    expectTypeOf(transport).toMatchTypeOf<DeployError>()
  })

  it('all DeployError variants carry the adapter field', () => {
    const err = new DeployAuthError('test', 'cloudflare-workers')
    expectTypeOf(err.adapter).toEqualTypeOf<string>()
  })

  it('DeployError variants are runtime-distinguishable via instanceof', () => {
    const auth = new DeployAuthError('test', 'cloudflare-workers')
    if (!(auth instanceof DeployError)) {
      throw new Error('DeployAuthError must extend DeployError')
    }
    if (!(auth instanceof DeployAuthError)) {
      throw new Error('instanceof check must work for DeployAuthError itself')
    }
    const config = new DeployConfigError('test', 'cloudflare-workers')
    if (config instanceof DeployAuthError) {
      throw new Error('DeployConfigError must NOT match DeployAuthError instanceof')
    }
  })
})

describe('TargetConfig integration', () => {
  it('has optional deploy?: DeployAdapter field', () => {
    expectTypeOf<TargetConfig['deploy']>().toEqualTypeOf<DeployAdapter | undefined>()
  })
})
