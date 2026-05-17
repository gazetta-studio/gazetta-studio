import { describe, expect, it } from 'vitest'
import { areaOf, scoreAreas, scoreOne, type GitFileTouch } from '../area-scorer.js'
import { type SkipList } from '../skip-list.js'

const emptySkipList = (): SkipList => ({ version: 1, entries: [], rules: [] })
const noBotPRs = new Map<string, string>()

const touch = (path: string, daysAgo = 1): GitFileTouch => ({
  path,
  lastTouchedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
})

describe('areaOf — path → area-prefix at depth N', () => {
  it('extracts depth-3 area for a deep gazetta path', () => {
    expect(areaOf('packages/gazetta/src/auth/principal.ts', 3)).toBe('packages/gazetta/src/')
  })

  it('caps at maxDepth even for deeper paths', () => {
    expect(areaOf('packages/gazetta/src/auth/sub/foo.ts', 3)).toBe('packages/gazetta/src/')
  })

  it('uses fewer segments when path is shallower than maxDepth', () => {
    expect(areaOf('apps/admin/foo.ts', 3)).toBe('apps/admin/')
    expect(areaOf('bots/fix-bot/index.ts', 3)).toBe('bots/fix-bot/')
  })

  it('returns null for top-level files', () => {
    expect(areaOf('README.md', 3)).toBe(null)
    expect(areaOf('package.json', 3)).toBe(null)
  })

  it('handles maxDepth=1 (top-level package only)', () => {
    expect(areaOf('packages/gazetta/src/auth/principal.ts', 1)).toBe('packages/')
  })
})

describe('scoreOne — composite scoring', () => {
  it('rewards more touched files linearly', () => {
    expect(scoreOne(10, 0)).toBeGreaterThan(scoreOne(5, 0))
    expect(scoreOne(10, 0) - scoreOne(5, 0)).toBeCloseTo(5)
  })

  it('rewards cold-on-bot areas (more days since bot touched = higher)', () => {
    expect(scoreOne(5, 30)).toBeGreaterThan(scoreOne(5, 1))
  })

  it('caps the recency bonus so an untouched area does not explode', () => {
    // Score for an area the bot has never touched (Infinity days) must
    // be finite + bounded.
    const score = scoreOne(5, Number.POSITIVE_INFINITY)
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeLessThan(1000)
  })

  it('cap kicks in at 60 days (same score for 60 vs 1000 days)', () => {
    expect(scoreOne(5, 60)).toBe(scoreOne(5, 1000))
  })
})

describe('scoreAreas — top-N selection with signals', () => {
  it('returns areas sorted by score descending', () => {
    const touches: GitFileTouch[] = [
      // packages/gazetta/src/auth/ — 5 files
      touch('packages/gazetta/src/auth/a.ts'),
      touch('packages/gazetta/src/auth/b.ts'),
      touch('packages/gazetta/src/auth/c.ts'),
      touch('packages/gazetta/src/auth/d.ts'),
      touch('packages/gazetta/src/auth/e.ts'),
      // apps/admin/src/ — 3 files
      touch('apps/admin/src/foo.ts'),
      touch('apps/admin/src/bar.ts'),
      touch('apps/admin/src/baz.ts'),
    ]
    const result = scoreAreas(touches, noBotPRs, emptySkipList(), { maxDepth: 4 })
    // Same recency bonus for both areas; the one with more touched files
    // outranks.
    expect(result[0]?.area).toBe('packages/gazetta/src/auth/')
    expect(result[1]?.area).toBe('apps/admin/src/')
    // touchedFiles is reflected accurately
    expect(result[0]?.touchedFiles).toBe(5)
    expect(result[1]?.touchedFiles).toBe(3)
  })

  it('drops areas below minTouchedFiles threshold', () => {
    const touches: GitFileTouch[] = [
      touch('packages/gazetta/src/auth/a.ts'),
      touch('packages/gazetta/src/auth/b.ts'), // only 2 files; threshold = 3
    ]
    const result = scoreAreas(touches, noBotPRs, emptySkipList(), { minTouchedFiles: 3 })
    expect(result).toHaveLength(0)
  })

  it('respects topN cap', () => {
    // 7 areas with 3 touches each
    const touches: GitFileTouch[] = []
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 3; j++) {
        touches.push(touch(`packages/p${i}/src/f${j}.ts`))
      }
    }
    const result = scoreAreas(touches, noBotPRs, emptySkipList(), { topN: 5, maxDepth: 3 })
    expect(result).toHaveLength(5)
  })

  it('ignores paths outside considerRoots', () => {
    const touches: GitFileTouch[] = [
      touch('packages/gazetta/src/auth/a.ts'),
      touch('packages/gazetta/src/auth/b.ts'),
      touch('packages/gazetta/src/auth/c.ts'),
      // Outside default considerRoots
      touch('docs/auth/a.md'),
      touch('docs/auth/b.md'),
      touch('docs/auth/c.md'),
    ]
    const result = scoreAreas(touches, noBotPRs, emptySkipList())
    expect(result.map((c) => c.area)).not.toContain('docs/auth/')
  })

  it('drops areas containing skip-list entries', () => {
    const touches: GitFileTouch[] = [
      touch('packages/gazetta/src/auth/a.ts'),
      touch('packages/gazetta/src/auth/b.ts'),
      touch('packages/gazetta/src/auth/c.ts'),
      touch('apps/admin/src/foo.ts'),
      touch('apps/admin/src/bar.ts'),
      touch('apps/admin/src/baz.ts'),
    ]
    const skipList: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: {
            area: 'packages/gazetta/src/auth/',
            type: 'security',
            rule: 'design-auth-rbac.md',
          },
          reason: 'wontfix',
          addedAt: new Date().toISOString(),
          addedBy: 'maintainer',
        },
      ],
      rules: [],
    }
    const result = scoreAreas(touches, noBotPRs, skipList, { maxDepth: 4 })
    // The auth area is excluded; only admin remains
    expect(result.map((c) => c.area)).toEqual(['apps/admin/src/'])
  })

  it('cold-on-bot area beats freshly-touched-by-bot area at same activity', () => {
    const touches: GitFileTouch[] = [
      // 3 files in 'cold' (bot never touched)
      touch('packages/cold/src/a.ts'),
      touch('packages/cold/src/b.ts'),
      touch('packages/cold/src/c.ts'),
      // 3 files in 'fresh' (bot opened a PR yesterday)
      touch('packages/fresh/src/a.ts'),
      touch('packages/fresh/src/b.ts'),
      touch('packages/fresh/src/c.ts'),
    ]
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const botPRs = new Map([['packages/fresh/src/', yesterday]])
    const result = scoreAreas(touches, botPRs, emptySkipList())
    // Cold area gets the maximum recency bonus (capped at 60d, treated
    // as Infinity); fresh area's recency bonus is ~1 day. So cold > fresh.
    expect(result[0]?.area).toBe('packages/cold/src/')
    expect(result[1]?.area).toBe('packages/fresh/src/')
  })
})
