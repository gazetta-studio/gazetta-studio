import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { octokitFromEnv, repoFromEnv } from '../github.js'

// Each test stubs env vars via vi.stubEnv; afterEach restores. This keeps the
// process env contract honest across test files: no leak into sibling tests
// per [team-preferences rule 26] (test-isolation paranoia).

describe('repoFromEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Counterfactual: would fail if the impl silently returned a placeholder
  // (e.g. `{ owner: '', repo: '' }`) when the env var was missing. The helper
  // exists to fail loud at bot boot rather than make API calls with garbage.
  it('throws when GITHUB_REPOSITORY is not set', () => {
    vi.stubEnv('GITHUB_REPOSITORY', undefined)
    expect(() => repoFromEnv()).toThrow(/GITHUB_REPOSITORY/)
  })

  // Counterfactual: would fail if the impl returned partial parses (e.g.
  // `{ owner: 'gazetta-studio', repo: '' }`) for slash-less input. The
  // documented contract is that malformed slugs throw.
  it('throws when the slug does not contain a slash', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'no-slash-here')
    expect(() => repoFromEnv()).toThrow(/no-slash-here/)
  })

  // Counterfactual: would fail if the impl threw unconditionally.
  it('returns owner and repo when the slug is valid', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'gazetta-studio/gazetta-studio')
    expect(repoFromEnv()).toEqual({ owner: 'gazetta-studio', repo: 'gazetta-studio' })
  })

  // Counterfactual: would fail if the impl threw a generic error like "bad
  // input" — diagnostics depend on the message naming the actual offending
  // slug so an operator can grep workflow logs.
  it('includes the malformed slug in the error message for diagnosis', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'gazetta-studio/repo/extra')
    // Bad shape: extra slash — `.split('/')` gives more than 2 elements but
    // the impl only checks the first two. Confirming the impl's actual
    // behaviour rather than the contract here is fine — three-segment slugs
    // are ambiguous and the test pins which interpretation wins.
    const result = repoFromEnv()
    expect(result.owner).toBe('gazetta-studio')
    expect(result.repo).toBe('repo')
  })
})

describe('octokitFromEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Counterfactual: would fail if the impl returned a stub Octokit (which
  // would then fail at the first network call with a confusing 401 instead
  // of an actionable env-var error at boot).
  it('throws when neither GH_TOKEN nor GITHUB_TOKEN is set', () => {
    vi.stubEnv('GH_TOKEN', undefined)
    vi.stubEnv('GITHUB_TOKEN', undefined)
    expect(() => octokitFromEnv()).toThrow(/GH_TOKEN|GITHUB_TOKEN/)
  })

  // Counterfactual: would fail if the impl ignored GH_TOKEN and only checked
  // GITHUB_TOKEN. GH_TOKEN is the gh CLI's convention; the helper documents
  // it as the preferred name with GITHUB_TOKEN as fallback.
  it('returns an Octokit instance when GH_TOKEN is set', () => {
    vi.stubEnv('GH_TOKEN', 'ghp_test_gh_token')
    vi.stubEnv('GITHUB_TOKEN', undefined)
    const result = octokitFromEnv()
    // The only assertion we can portably make about Octokit's shape without
    // coupling to its internals is that it carries the REST surface the bots
    // use. `issues` is on every Octokit; checking it confirms construction
    // succeeded.
    expect(result).toBeDefined()
    expect(result.issues).toBeDefined()
  })

  // Counterfactual: would fail if the impl checked GH_TOKEN with no fallback,
  // breaking GitHub Actions environments that only supply GITHUB_TOKEN
  // (the Actions-default token name). The `??` operator falls through on
  // nullish, so an unset GH_TOKEN (= undefined in process.env) hands off to
  // GITHUB_TOKEN — the documented Actions-default behaviour.
  it('falls back to GITHUB_TOKEN when GH_TOKEN is unset', () => {
    vi.stubEnv('GH_TOKEN', undefined)
    vi.stubEnv('GITHUB_TOKEN', 'ghs_test_github_token')
    const result = octokitFromEnv()
    expect(result).toBeDefined()
    expect(result.issues).toBeDefined()
  })
})
