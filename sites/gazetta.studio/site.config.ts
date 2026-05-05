import { defineSite } from 'gazetta'

export default defineSite({
  name: 'Gazetta Studio',
  locale: 'en',
  targets: {
    local: {
      storage: { type: 'filesystem' },
      // Defaults: environment=local (editable); path=./targets/local
    },
    production: {
      storage: {
        type: 'r2',
        accountId: '30ec7440a8cdafa137c993cd4a0f4c67',
        bucket: 'gazetta-studio-site',
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      worker: {
        type: 'cloudflare',
        name: 'gazetta-studio',
      },
      environment: 'production',
      siteUrl: 'https://gazetta.studio',
      cache: {
        browser: 0,
        edge: 86400,
        purge: {
          type: 'cloudflare',
          apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        },
      },
    },
  },
})
