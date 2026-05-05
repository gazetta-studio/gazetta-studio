import { defineSite, filesystemStorage, r2Storage } from 'gazetta'

export default defineSite({
  name: 'Gazetta Studio',
  locale: 'en',
  targets: {
    local: {
      // Relative paths are anchored to this config file's directory.
      storage: filesystemStorage({ path: './targets/local' }),
      // Defaults: environment=local (editable)
    },
    production: {
      storage: r2Storage({
        accountId: '30ec7440a8cdafa137c993cd4a0f4c67',
        bucket: 'gazetta-studio-site',
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
      worker: {
        type: 'cloudflare',
        name: 'gazetta-studio',
        bucket: 'gazetta-studio-site',
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
