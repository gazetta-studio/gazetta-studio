import { defineConfig } from '@playwright/test'

/**
 * Runs docs/getting-started.md's commands word for word against a packed
 * tarball served from a local registry (design-tutorial.md, "The CI check").
 * One worker: the tutorial uses fixed ports (3000, 3001) and one project.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // `init` installs the site's dependencies through the local registry,
  // which fetches everything except gazetta from npmjs on a cold cache.
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    baseURL: 'http://localhost:3000',
    // A click on a disabled button fails within a minute, not at the test timeout.
    actionTimeout: 60_000,
  },
})
