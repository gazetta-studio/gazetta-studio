import { defineSite, filesystemStorage, azureBlobStorage } from 'gazetta'

export default defineSite({
  name: 'Gazetta Starter',
  version: '1.0.0',
  locale: 'en',
  locales: {
    supported: ['en', 'fr', 'ar', 'ja'],
  },
  systemPages: ['404'],

  // AI integration (optional). Uncomment to enable AI-powered alt-text
  // generation. Provider credentials live in `.env.local` (gitignored)
  // — never in this file. See docs/content-assets.md for setup.
  //
  // ai: {
  //   provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  //   model: 'claude-haiku-4-5',      // optional; falls back to per-provider default
  // },
  //
  // altText: {
  //   systemPrompt: 'descriptive, screen-reader-friendly',  // optional voice override
  //   maxTokens: 300,                                       // optional generation cap
  // },

  targets: {
    local: {
      // Relative paths are anchored to this config file's directory
      // (./targets/local resolves under sites/main/targets/local).
      storage: filesystemStorage({ path: './targets/local' }),
      // environment: 'local' (default)
      // editable: true (default for local environment)
    },
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      environment: 'staging',
    },
    'esi-test': {
      storage: filesystemStorage({ path: './dist/esi-test' }),
      type: 'dynamic',
      environment: 'staging',
    },
    production: {
      storage: azureBlobStorage({
        connectionString: 'UseDevelopmentStorage=true',
        container: 'gazetta-production',
      }),
      environment: 'production',
      // Uncomment to require explicit click-to-suggest on production
      // (review-first workflow). Behavior fields live at the root of altText:
      // altText: { auto: false },
    },
  },
})
