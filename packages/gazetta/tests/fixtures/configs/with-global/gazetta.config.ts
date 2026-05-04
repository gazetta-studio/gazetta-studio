import { defineGazetta } from '../../../../src/config/define.js'

export default defineGazetta({
  logLevel: 'info',
  defaults: {
    cache: { provider: 'memory' },
    audit: { provider: 'history' },
  },
})
