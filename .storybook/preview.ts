import type { Preview } from '@storybook/vue3-vite'
import { setup } from '@storybook/vue3-vite'
import { withThemeByClassName } from '@storybook/addon-themes'
import { createPinia } from 'pinia'

// App-level CSS tokens and page base styles, as main.ts loads them. See
// .claude/rules/css-theming.md for the token model.
import '../apps/admin/src/client/assets/tokens.css'
import '../apps/admin/src/client/assets/base.css'

// Register Pinia once per preview boot, as apps/admin/src/client/main.ts
// does. VueQuery / Router / service worker / IndexedDB persistence are
// intentionally omitted — stories that need router or store data mock
// per-story. Dark mode is the `.dark` class on <html>, set by the
// withThemeByClassName decorator below, which flips the tokens.
setup(app => {
  app.use(createPinia())
})

const preview: Preview = {
  decorators: [
    // Both light + dark land an explicit class on <html>. Per team-
    // preferences rule 12 the running app applies both classes (only one
    // active at a time); the decorator mirrors that so stories render
    // identically to the deployed admin.
    withThemeByClassName({
      themes: { light: 'light', dark: 'dark' },
      defaultTheme: 'light',
      parentSelector: 'html',
    }),
  ],
  parameters: {
    // Fail the story run on axe violations (#524, ADR-0016), color-contrast
    // included (#863). The addon's default only reports them, which would
    // leave the a11y half of the story gate advisory.
    a11y: { test: 'error' },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
}

export default preview
