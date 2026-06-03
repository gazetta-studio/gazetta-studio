/**
 * Per-scenario isolation — reset the mutable surfaces between scenario
 * tests so each starts from a known baseline.
 *
 * Rationale: the testSite fixture is worker-scoped (see fixtures.ts).
 * Scenarios mutate both the editable source (local's pages/home/page.json)
 * and every target's dist dir. Without reset-between-tests, scenario N+1
 * inherits scenario N's changes, which hides bugs and makes failures
 * order-dependent.
 *
 * SRP: this module owns "what needs to be clean between scenarios".
 * Each helper does one thing; `resetScenarioState` composes them.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rmSafe } from '../_helpers/rm-safe.js'

/**
 * Pristine content of local's home page — the baseline every scenario
 * starts from. Mirrors examples/starter/sites/main/targets/local/pages/
 * home/page.json exactly. If the starter's home page changes, this
 * constant must track it (keep the two in sync via CI check, or accept
 * the test failure as a reminder).
 *
 * Encoded inline rather than re-read from the repo's examples dir so
 * scenarios stay deterministic even if someone edits the starter.
 */
const PRISTINE_HOME: Record<string, unknown> = {
  template: 'page-default',
  content: {
    title: 'Home',
    description: 'Welcome to Gazetta',
  },
  components: [
    '@header',
    {
      name: 'hero',
      template: 'hero',
      content: {
        title: 'Welcome to Gazetta',
        subtitle: 'A stateless CMS that composes pages from reusable components',
      },
    },
    {
      name: 'features',
      template: 'features-grid',
      content: {
        items: [
          { title: 'Stateless', description: 'All content lives in targets — the CMS is disposable' },
          { title: 'Composable', description: 'Pages built from reusable fragments and components' },
          { title: 'Framework-agnostic', description: 'Templates can use any framework' },
        ],
      },
    },
    '@footer',
  ],
}

/** Dist dirs every scenario should wipe before running. Matches
 *  site.config.ts targets in examples/starter, with `production`
 *  swapped to `prod-test` per the fixtures.ts patch. */
const TARGET_DIST_DIRS = ['dist/staging', 'dist/esi-test', 'dist/prod-test'] as const

/**
 * Restore local's pages/home/page.json to the pristine starter state.
 * Scenarios edit the title then save, which leaves the file modified.
 * Without this, scenario #2 would see "edited title" as the baseline.
 */
export async function restorePristineHome(projectDir: string): Promise<void> {
  const path = join(projectDir, 'sites/main/targets/local/pages/home/page.json')
  await writeFile(path, JSON.stringify(PRISTINE_HOME, null, 2) + '\n')
}

/**
 * Wipe every target's dist dir + its .gazetta/history/ subdir so each
 * scenario starts with all targets in "firstPublish" state.
 */
export async function wipeAllTargetDists(projectDir: string): Promise<void> {
  const sitesMain = join(projectDir, 'sites/main')
  await Promise.all(TARGET_DIST_DIRS.map(d => rmSafe(join(sitesMain, d))))
  // local's content dir also has a .gazetta/history/ from prior tests — wipe
  // that too so history-touching scenarios start from zero revisions.
  await rmSafe(join(sitesMain, 'targets/local/.gazetta'))
}

/**
 * Full reset — composes the per-surface helpers. Call from
 * `test.beforeEach` in every scenario file.
 */
export async function resetScenarioState(projectDir: string): Promise<void> {
  await restorePristineHome(projectDir)
  await wipeAllTargetDists(projectDir)
}

/**
 * Verify the reset worked — sanity check used inside the isolation
 * helper's own test, not in scenarios. Exported so a unit test can
 * assert the fixture is what we expect.
 */
export async function verifyPristineHome(projectDir: string): Promise<boolean> {
  const path = join(projectDir, 'sites/main/targets/local/pages/home/page.json')
  const contents = await readFile(path, 'utf-8')
  return JSON.parse(contents).content.title === 'Home'
}
