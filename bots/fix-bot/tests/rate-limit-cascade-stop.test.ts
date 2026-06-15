/**
 * Fix-bot symmetric audit of feature-bot's rate-limit cascade-stop
 * (rule 38). The fix-bot has the same outer-loop structure and the
 * same vulnerability — one rate-limited candidate followed by N
 * 4-second crashes that would each get a stuck-comment + a
 * ready-for-human label.
 *
 * Same shape of structural assertion as feature-bot's test.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = resolve(HERE, '..', 'index.ts')
const source = readFileSync(INDEX_PATH, 'utf-8')

describe('fix-bot — rate-limit cascade stop', () => {
  it('imports detectRateLimit from the shared lib', () => {
    expect(source).toMatch(/import\s+\{[^}]*detectRateLimit[^}]*\}\s+from\s+['"]\.\.\/_lib\/claude/)
  })

  it('breaks the outer candidate loop when a rate-limit is detected', () => {
    const outerLoop = source.match(/for \(const candidate of candidates\)[\s\S]+?\n  \}\n/)
    expect(outerLoop, 'outer candidate loop must exist').toBeTruthy()
    const body = outerLoop?.[0] ?? ''
    expect(body).toMatch(/rateLimited/)
    expect(body).toMatch(/break/)
  })

  it('emits a clear warning when stopping the loop due to rate-limit', () => {
    expect(source).toMatch(/printWarning\([^)]*(?:rate[- ]?limit|session[- ]?limit)/i)
  })

  it('checks detectRateLimit BEFORE postFailureComment so a rate-limited Agent A does NOT escalate', () => {
    // The Agent A failure path used to be: `printWarning + postFailureComment
    // + break`. After the fix it's: check detectRateLimit FIRST → if true,
    // stop the queue; ONLY THEN post the failure comment + escalate. Without
    // the ordering, rate-limited cuts get stuck-comments + ready-for-human
    // (the symptom we're fixing).
    const failurePath = source.match(/if \(!aResult\.success\)[\s\S]+?postFailureComment/)
    expect(failurePath, 'Agent A failure path with postFailureComment must exist').toBeTruthy()
    const region = failurePath?.[0] ?? ''
    // detectRateLimit must appear in the failure-handling region before
    // postFailureComment is reached.
    const detectIdx = region.indexOf('detectRateLimit')
    const escalateIdx = region.indexOf('postFailureComment')
    expect(detectIdx).toBeGreaterThan(-1)
    expect(detectIdx).toBeLessThan(escalateIdx)
  })
})
