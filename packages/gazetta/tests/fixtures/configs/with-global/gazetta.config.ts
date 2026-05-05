import { defineGazetta } from '../../../../src/config/define.js'

export default defineGazetta({
  logLevel: 'info',
  defaults: {
    // Exception A — raw MemoryCache options. Each inheriting site builds
    // its own per-site cache instance from these, preserving per-site
    // isolation (`design-cache.md` Gap 3).
    cache: { maxEntries: 5000 },
    audit: { provider: 'history' },
  },
})
