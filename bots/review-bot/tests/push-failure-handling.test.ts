/**
 * Structural test for review-bot's push-failure handling.
 *
 * Run #26707064619 (2026-05-31) reached APPROVE, then crashed at
 * `git push` with `fatal: invalid refspec` because of an unsanitized
 * branch name. The root cause was fixed in #477. But the orchestrator
 * also had no try/catch around `phase5Push`, so any future push or
 * PR-create failure (network, auth, remote rejection, refspec issues)
 * would crash the bot with exit 1 + no skip-list entry → next cron
 * redoes all the work + crashes again.
 *
 * fix-bot's `pushBranch` wraps `execFileSync('git', ['push', ...])` in
 * try/catch + `printWarning`. Rule 38 (audit symmetric bots when
 * fixing a pattern bug) says: when review-bot crashes on a shape that
 * fix-bot handles gracefully, the symmetric fix lands here.
 *
 * This is a structural test per rule 40: assert the catch path is
 * present at the `phase5Push` call site. The catch must record a
 * needs-human skip-list entry + exit cleanly. Compiler can't enforce
 * either invariant — both are pure runtime behavior reachable only
 * via execFileSync failure paths, which can't be cheaply exercised
 * in a unit test without mocking the entire orchestrator.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = join(__dirname, '..', 'index.ts')

describe('review-bot phase5Push failure handling', () => {
  it('wraps the phase5Push call in try/catch with a needs-human skip-list write', async () => {
    const source = await readFile(INDEX_PATH, 'utf8')

    // The APPROVE-verdict branch must call phase5Push inside a try
    // block; the catch must route through openSkipListPR (which writes
    // skip-list locally AND opens a draft PR to commit the entry to
    // main — the persistence layer added in the rule-38 follow-up).
    // We assert the structural shape with a single multi-line regex
    // that captures the contract:
    //
    //   try {
    //     await phase5Push(...)
    //     ...
    //   } catch (err) {
    //     ...
    //     await openSkipListPR(octokit, repo, skipList, fingerprint, {
    //       reason: 'needs-human', ...
    //     })
    //     ...
    //     process.exit(0)
    //   }
    //
    // We don't pin the exact whitespace / variable names — just the
    // load-bearing structural invariant.
    const approvePath = source.match(
      /verdict\.kind === 'approve'[\s\S]*?try \{[\s\S]*?await phase5Push\([\s\S]*?\} catch \([\s\S]*?openSkipListPR\([\s\S]*?reason: 'needs-human'[\s\S]*?process\.exit\(0\)[\s\S]*?\}/,
    )
    expect(
      approvePath,
      'phase5Push call must be wrapped in try/catch that routes through openSkipListPR (durable persistence) + exits cleanly',
    ).toBeTruthy()
  })
})
