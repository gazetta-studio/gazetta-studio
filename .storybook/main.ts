import type { StorybookConfig } from '@storybook/vue3-vite'
import vue from '@vitejs/plugin-vue'

const config: StorybookConfig = {
  stories: ['../apps/admin/src/client/**/*.stories.@(js|ts)'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-themes'],
  framework: '@storybook/vue3-vite',
  // `@storybook/vue3-vite`'s built-in `viteFinal` adds Storybook's own
  // template-compilation + vue-docgen plugins but NOT the standard
  // `@vitejs/plugin-vue` SFC transform. Without it, importing `.vue`
  // files from a story fails with 404 at the SFC URL. We add the
  // plugin here so admin SFCs (which already use it in apps/admin/
  // vite.config.ts) resolve identically inside Storybook.
  viteFinal: async config => {
    const { mergeConfig } = await import('vite')
    return mergeConfig(config, {
      plugins: [vue()],
    })
  },
}

export default config
