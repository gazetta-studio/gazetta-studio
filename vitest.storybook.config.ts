import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// Runs every story in .storybook/main.ts's `stories` glob as a vitest browser
// test — the story render gate the review-workflow UX cuts build against
// (#524, ADR-0016). A story that throws on render, or whose `play` function
// fails, fails the run. Separate file (not a root vitest.config.ts) so it is
// only ever used by `npm run test:storybook`, never picked up implicitly.
// Shape from @storybook/addon-vitest's own Vitest 4 template; project
// annotations (.storybook/preview.ts) are injected by the plugin, so no
// setup file is needed.
/**
 * One Vitest project per admin theme, so every story — and axe's
 * color-contrast check — runs in light AND dark. `initialGlobals.theme` is
 * the global `withThemeByClassName` in .storybook/preview.ts reads; the
 * addon documents per-project `initialGlobals` for exactly this.
 */
const themeProject = (theme: 'light' | 'dark') => ({
  extends: true,
  plugins: [storybookTest({ configDir: path.join(dirname, '.storybook'), initialGlobals: { theme } })],
  test: {
    name: `storybook-${theme}`,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({}),
      instances: [{ browser: 'chromium' as const }],
    },
  },
})

export default defineConfig({
  test: {
    projects: [themeProject('light'), themeProject('dark')],
  },
})
