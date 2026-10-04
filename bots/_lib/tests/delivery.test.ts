/**
 * Behavioral tests for bots/_lib/delivery.ts against a real git repo and a
 * real bare remote — the bug (#840) was a push rejection the bots swallowed,
 * so the test makes the remote actually reject (a pre-receive hook) rather
 * than mocking git.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deliveryFailureComment, fenceFor, INLINE_PATCH_LIMIT, pushBranch, runGh, savePatch } from '../delivery.js'

let root: string
let work: string
let remote: string
let out: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delivery-'))
  remote = join(root, 'remote.git')
  work = join(root, 'work')
  out = join(root, 'out')
  execFileSync('git', ['init', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-b', 'main', work])
  execFileSync('mkdir', [out])
  git(work, 'config', 'user.email', 'bot@example.com')
  git(work, 'config', 'user.name', 'bot')
  git(work, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(work, 'a.txt'), 'base\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'base')
  git(work, 'remote', 'add', 'origin', remote)
  git(work, 'push', '-u', 'origin', 'main')
  git(work, 'checkout', '-b', 'feat/cut-1')
  writeFileSync(join(work, 'a.txt'), 'base\napproved change\n')
  git(work, 'commit', '-am', 'approved change')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function rejectPushes(message: string): void {
  const hook = join(remote, 'hooks', 'pre-receive')
  writeFileSync(hook, `#!/bin/sh\necho "${message}" >&2\nexit 1\n`)
  chmodSync(hook, 0o755)
}

describe('pushBranch', () => {
  it('reports ok and the branch lands on the remote', () => {
    expect(pushBranch('feat/cut-1', { cwd: work, forceWithLease: true })).toEqual({ ok: true })
    expect(git(remote, 'log', '--format=%s', '-1', 'feat/cut-1')).toBe('approved change')
  })

  it('reports the rejection with the remote’s reason instead of swallowing it', () => {
    rejectPushes('refusing to allow a GitHub App to create or update workflow')
    const r = pushBranch('feat/cut-1', { cwd: work, forceWithLease: true })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('refusing to allow a GitHub App')
  })

  it('force-with-lease replaces a stale leftover branch; a plain push is rejected (#550)', () => {
    // A prior run left a diverged branch of the same name on the remote.
    git(work, 'checkout', '-b', 'stale', 'main')
    writeFileSync(join(work, 'b.txt'), 'stale\n')
    git(work, 'add', '.')
    git(work, 'commit', '-m', 'stale')
    git(work, 'push', 'origin', 'stale:feat/cut-1')
    git(work, 'fetch', 'origin')
    git(work, 'checkout', 'feat/cut-1')

    expect(pushBranch('feat/cut-1', { cwd: work, forceWithLease: false }).ok).toBe(false)
    expect(pushBranch('feat/cut-1', { cwd: work, forceWithLease: true })).toEqual({ ok: true })
    expect(git(remote, 'log', '--format=%s', '-1', 'feat/cut-1')).toBe('approved change')
  })
})

describe('runGh', () => {
  it('reports a non-zero exit as a failure', () => {
    // An unknown subcommand fails whether or not gh is authenticated; a
    // missing gh binary fails too — either way the result must say so.
    const r = runGh(['definitely-not-a-gh-command'], work)
    expect(r.ok).toBe(false)
  })
})

describe('savePatch', () => {
  it('saves the branch’s commits as a patch that git am re-applies on main', () => {
    const saved = savePatch({ cwd: work, dir: out, name: 'cut-1', branch: 'feat/cut-1' })
    expect(saved).not.toBeNull()
    expect(readFileSync(join(out, 'cut-1.patch'), 'utf-8')).toBe(saved?.text)

    // The escalation resets to main, discarding the commits — the patch is
    // the only copy, so prove it restores them.
    git(work, 'checkout', 'main')
    git(work, 'branch', '-D', 'feat/cut-1')
    execFileSync('git', ['am', join(out, 'cut-1.patch')], { cwd: work, stdio: 'ignore' })
    expect(readFileSync(join(work, 'a.txt'), 'utf-8')).toBe('base\napproved change\n')
  })

  it('reads the named branch, not whatever HEAD is', () => {
    git(work, 'checkout', 'main')
    expect(savePatch({ cwd: work, dir: out, name: 'x', branch: 'feat/cut-1' })?.text).toContain('approved change')
  })

  it('returns null when the branch has nothing beyond the base', () => {
    expect(savePatch({ cwd: work, dir: out, name: 'none', branch: 'main' })).toBeNull()
  })
})

describe('deliveryFailureComment', () => {
  const base = {
    bot: 'feature-bot',
    issueNumber: 524,
    branch: 'feat/cut-524',
    error: 'refusing to allow a GitHub App to create or update workflow',
    runUrl: 'https://example/run/1',
    runId: '1',
  }

  it('push stage: names the error, the artifact, and inlines a small patch', () => {
    const body = deliveryFailureComment({
      ...base,
      stage: 'push',
      patch: { path: '/x/p.patch', text: 'diff --git a/a b/a\n' },
      patchFileName: 'p.patch',
    })
    expect(body).toContain('Approved, but not delivered')
    expect(body).toContain(base.error)
    expect(body).toContain('git am < p.patch')
    expect(body).toContain('diff --git a/a b/a')
    expect(body).toMatch(/<!-- feature-bot: delivery-failed issue=524 stage=push run=1 -->$/)
  })

  it('does not inline a patch over the limit', () => {
    const big = 'x'.repeat(INLINE_PATCH_LIMIT + 1)
    const body = deliveryFailureComment({
      ...base,
      stage: 'push',
      patch: { path: '/p', text: big },
      patchFileName: 'p',
    })
    expect(body).not.toContain(big)
    expect(body).toContain('git am < p')
  })

  it('pr stage: the branch was pushed, so it points there and attaches no patch', () => {
    const body = deliveryFailureComment({ ...base, stage: 'pr', patch: null, patchFileName: null })
    expect(body).toContain('was pushed')
    expect(body).not.toContain('git am')
  })

  it('a patch containing a ``` fence cannot close the comment’s fence early', () => {
    const text = 'diff\n+```ts\n+code\n+```\n'
    const body = deliveryFailureComment({ ...base, stage: 'push', patch: { path: '/p', text }, patchFileName: 'p' })
    const fence = fenceFor(text)
    expect(fence).toBe('````')
    expect(body).toContain(`${fence}diff\n${text}\n${fence}`)
  })
})
