/** #1754: `--targets` refuses what it can't check rather than skipping it (Seer on #1757). */
import { describe, expect, it } from 'vitest'
import { resolveTargets, TargetRefusal } from '../src/cli/validate-targets.js'
import type { StorageProvider, TargetConfig } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const privateTarget = (storage: StorageProvider): TargetConfig => ({ storage, publicStorage: false })

describe('resolveTargets', () => {
  it('refuses a list that names no target', async () => {
    const configs = { staging: privateTarget(memoryStorage()) }
    await expect(resolveTargets([], configs)).rejects.toThrow(TargetRefusal)
    await expect(resolveTargets([], configs)).rejects.toThrow('names no target')
  })

  it('refuses a target whose storage never answers, instead of hanging', async () => {
    const hanging = { ...memoryStorage(), init: () => new Promise<void>(() => {}) } as StorageProvider
    const result = resolveTargets(['staging'], { staging: privateTarget(hanging) }, 50)
    await expect(result).rejects.toThrow("Couldn't read target `staging`: no answer after 0.05 s")
  })

  it('accepts a readable private target', async () => {
    const sources = await resolveTargets(['staging'], { staging: privateTarget(memoryStorage()) })
    expect(sources.map(s => s.name)).toEqual(['staging'])
  })
})
