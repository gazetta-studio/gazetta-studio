import { z } from 'zod'
import { embeddedAsset } from '../../../../src/schema/index.js'

export const schema = z.object({
  slides: z.array(z.object({ image: embeddedAsset({ accept: ['image'], altRequired: true }) })),
})

type Content = z.infer<typeof schema>

export default ({ content }: { content: Content }) => ({
  html: content.slides.map(s => `<img src="${s.image._asset}">`).join(''),
  css: '',
  js: '',
})
