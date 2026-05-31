/**
 * PROOF that commit e79befb's push-failure fix is ineffective for its
 * stated purpose: the skip-list entry it records never reaches the next
 * cron, so the redo-loop the commit claims to prevent still happens.
 *
 * The commit message claims:
 *
 *   "Before this fix: any push or PR-create error ... would crash the
 *    bot with exit 1, leaving no skip-list entry. The next cron would
 *    redo all of Agent A + Agent B work + crash again on the same root
 *    cause."
 *
 * and that the catch (which calls `writeSkipList` + `process.exit(0)`)
 * fixes that by "record[ing] a needs-human skip-list entry".
 *
 * BUT: `writeSkipList(SKIPLIST_PATH, ...)` only writes the runner-local
 * working tree. review-bot has NO step that commits / pushes / PRs the
 * skip-list back to `main` (verified below: index.ts has no git-add /
 * commit / push of the skip-list, and the only `pulls.create` is the
 * improvement PR inside `phase5Push`'s SUCCESS path). The GitHub Actions
 * runner is torn down at job end, discarding the uncommitted change.
 *
 * The next cron checks out a fresh clone and reads the COMMITTED
 * `skip-list.json` (HEAD), which never received the entry — so it
 * re-picks the same candidate and redoes Agent A + Agent B + crashes
 * again. Exactly the loop the commit claims to close.
 *
 * fix-bot — cited in the commit as the rule-38 mirror — solves this in
 * `escalateToHuman` by opening a `fix-bot-skip/...` PR. review-bot
 * copied only fix-bot's try/catch shape, not its persistence half.
 *
 * These tests model the runner-teardown boundary by distinguishing the
 * working-tree write from the committed source-of-truth the next cron
 * reads. They cannot drive a real runner; what they assert is that the
 * code contains no mechanism to bridge that boundary.
 *
 * THE FIX (when this goes red→green): give review-bot an
 * `escalateToHuman` / `openSkipListPR` equivalent of fix-bot's (index.ts
 * ~626-700) and route all five `writeSkipList` exit paths
 * (index.ts:137, 182, 241, 251, 265) through it. The two source-scan
 * tests flip green the moment that mechanism exists; the git test flips
 * green once the catch path actually commits the entry.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSkipList, recordSkipListEntry, writeSkipList, type Fingerprint } from '../skip-list.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = join(HERE, '..', 'index.ts')
const FIXBOT_INDEX = join(HERE, '..', '..', 'fix-bot', 'index.ts')

const fp: Fingerprint = {
  area: 'packages/gazetta/src/auth/',
  type: 'security',
  rule: 'design-auth-rbac.md#capability-gate',
}

describe('review-bot push-failure skip-list PERSISTENCE (proves e79befb ineffective)', () => {
  let dir: string
  let skipPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-bot-persist-'))
    skipPath = join(dir, 'skip-list.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('review-bot index.ts has no mechanism to land the skip-list write on main', async () => {
    const src = await readFile(INDEX_PATH, 'utf8')

    // The only durable-persistence shapes a bot can use: commit the file
    // to a branch + push it (dead-code-watcher / fix-bot pattern), or
    // open a skip-list PR. review-bot has neither — its single
    // pulls.create is the improvement PR inside phase5Push's success
    // path, and there is no git add/commit/push of skip-list.json.
    const commitsSkipList = /git['"\s,]+\[?\s*['"]commit['"][\s\S]{0,400}skip-list/.test(src)
    const opensSkipPr = /skip[-_]?(list|branch)[\s\S]{0,200}pulls\.create|chore\(skip-list\)/i.test(src)

    expect(
      commitsSkipList || opensSkipPr,
      'review-bot must commit/push or PR the skip-list so the catch entry survives runner teardown — it does neither',
    ).toBe(true)
  })

  it('fix-bot (the cited rule-38 mirror) DOES persist its skip-list — review-bot omitted that half', async () => {
    const fixbot = await readFile(FIXBOT_INDEX, 'utf8')
    // Proves the asymmetry the commit message glosses over: it cites
    // fix-bot as the mirror, but fix-bot has the persistence step
    // review-bot lacks. If this assertion ever fails, fix-bot lost its
    // persistence and the "mirror" framing collapses entirely.
    expect(
      /chore\(skip-list\)/.test(fixbot) && /git['"\s,]+\[?\s*['"]push['"]/.test(fixbot),
      'fix-bot escalateToHuman commits + pushes a skip-list PR (the step review-bot copied from but omitted)',
    ).toBe(true)
  })

  it('end-to-end via git: openSkipListPR commits the entry so the next cron reads it', async () => {
    // Strongest form: use a real throwaway git repo to model the
    // commit-boundary. The helper writes the working tree AND commits,
    // so `git show HEAD:` (what a fresh next-cron clone sees) gains
    // the entry.
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' })
    git('init', '-q')
    git('checkout', '-q', '-b', 'main')
    writeSkipList(skipPath, { version: 1, entries: [], rules: [] })
    git('add', 'skip-list.json')
    git('commit', '-q', '-m', 'init empty skip-list')

    // Fake octokit + repo. The PR-creation step normally calls
    // octokit.pulls.create which we can't drive against a real
    // remote in a vitest sandbox. Make it a no-op; the helper's
    // git ops (the load-bearing persistence step) still happen.
    // We also fake the `git push` by pointing origin at a bare
    // local repo so push doesn't network-fail.
    const bare = join(dir, '..', `bare-${Math.random().toString(36).slice(2, 8)}.git`)
    execFileSync('git', ['init', '-q', '--bare', bare], { env, stdio: 'pipe' })
    git('remote', 'add', 'origin', bare)
    const fakeOctokit = { pulls: { create: async () => ({ data: { number: 1 } }) } } as never
    const fakeRepo = { owner: 'test', repo: 'test' } as never

    // The fix path: write the entry, branch, commit, push, PR.
    const { openSkipListPR } = await import('../index.js')
    await openSkipListPR(fakeOctokit, fakeRepo, readSkipList(skipPath), fp, {
      reason: 'needs-human',
      reasonNote: 'push failed',
      cwd: dir,
      skipListPath: skipPath,
      skipListRelPath: 'skip-list.json',
    })

    // What the next cron's fresh clone sees: the SKIP BRANCH carries
    // the entry. (main isn't bumped because the PR isn't merged; that's
    // the maintainer's job. But the next cron checks remote PRs +
    // applies skip-list before picking, so the branch's content is
    // what gates re-attempt — and the branch HAS the entry.)
    const branches = execFileSync('git', ['branch', '--list', 'review-bot-skip/*'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    })
    expect(branches.trim().length, 'review-bot-skip/* branch must exist').toBeGreaterThan(0)

    const skipBranchName = branches.trim().replace(/^\*?\s+/, '')
    const committed = execFileSync('git', ['show', `${skipBranchName}:skip-list.json`], {
      cwd: dir,
      env,
      encoding: 'utf8',
    })
    const nextCronList = JSON.parse(committed) as { entries: unknown[] }

    expect(
      nextCronList.entries.length,
      'committed skip-list on review-bot-skip/* branch must contain the recorded entry',
    ).toBeGreaterThan(0)
  })
})
