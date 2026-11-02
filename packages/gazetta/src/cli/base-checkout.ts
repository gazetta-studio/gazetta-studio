/**
 * The base commit's copy of the project, for `gazetta validate --base`
 * (design-template-check.md T2, #1750).
 *
 * The project's folder at that commit is extracted with `git archive` into a
 * folder inside the project, `.gazetta/tmp/base-<sha>-<pid>/`, so its
 * templates' imports (`gazetta`, `react`, ...) resolve to the project's own
 * `node_modules`. `git archive` rather than `git worktree add`: it copies only
 * the project's files, and leaves nothing in the repository to prune if the
 * run is killed. `remove()` deletes the folder; callers run it in `finally`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { STATE_ROOT } from '../state-folders.js'

/** A `--base` that can't be used: exit code 2. */
export class BaseRefError extends Error {}

export interface BaseCheckout {
  /** The commit `ref` resolved to. */
  sha: string
  /** The base commit's project folder and site folder. */
  projectRoot: string
  siteDir: string
  remove(): void
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function checkoutBase(ref: string, projectRoot: string, siteDir: string): BaseCheckout {
  let gitRoot: string
  let sha: string
  try {
    gitRoot = git(projectRoot, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new BaseRefError(`--base needs a git repository, and ${projectRoot} isn't in one.`)
  }
  try {
    sha = git(projectRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  } catch {
    throw new BaseRefError(
      `--base ${ref}: git can't find that commit. Fetch it first (for example \`git fetch origin main\`).`,
    )
  }

  // git prints the root's real path; resolve symlinks (macOS's /tmp) before comparing.
  const projectInRepo = relative(realpathSync(gitRoot), realpathSync(projectRoot))
  // In the project's own state folder, not a target's: gitignored, and never published.
  const folder = join(projectRoot, STATE_ROOT, 'tmp', `base-${sha.slice(0, 12)}-${process.pid}`)
  const remove = () => rmSync(folder, { recursive: true, force: true })
  remove()
  mkdirSync(folder, { recursive: true })
  try {
    // The archive keeps paths from the repository root; extract just the project's subtree.
    const archive = execFileSync('git', ['archive', '--format=tar', sha, '--', projectInRepo || '.'], {
      cwd: gitRoot,
      maxBuffer: 1024 * 1024 * 1024,
    })
    execFileSync('tar', ['-x', '-f', '-', '-C', folder], { input: archive })
  } catch (err) {
    remove()
    throw new BaseRefError(`--base ${ref}: couldn't read the project at ${sha.slice(0, 12)}: ${(err as Error).message}`)
  }

  const baseProjectRoot = join(folder, projectInRepo)
  const baseSiteDir = join(baseProjectRoot, relative(projectRoot, siteDir))
  if (!existsSync(baseSiteDir)) {
    remove()
    throw new BaseRefError(
      `--base ${ref}: the commit ${sha.slice(0, 12)} has no site at ${relative(gitRoot, siteDir)}.`,
    )
  }
  return { sha, projectRoot: baseProjectRoot, siteDir: baseSiteDir, remove }
}
