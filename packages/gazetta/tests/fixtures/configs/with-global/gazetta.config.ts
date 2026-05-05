import { memoryCache } from '../../../../src/cache/factories.js'
import { defineGazetta } from '../../../../src/config/define.js'

export default defineGazetta({
  logLevel: 'info',
  defaults: {
    // Path X — factory result. Per the single-Site-per-process invariant
    // in CONTEXT.md, each process re-evaluates this config and gets a
    // fresh AdminCache instance, so no per-Site reconstruction is needed.
    cache: memoryCache({ maxEntries: 5000 }),
    audit: { provider: 'history' },
  },
})
