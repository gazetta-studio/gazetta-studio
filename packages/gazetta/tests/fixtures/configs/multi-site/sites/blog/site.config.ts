import { defineSite } from '../../../../../../src/config/define.js'

export default defineSite({
  name: 'blog',
  locales: { default: 'en', supported: ['en'] },
  themes: { supported: ['light', 'dark'], default: 'light' },
})
