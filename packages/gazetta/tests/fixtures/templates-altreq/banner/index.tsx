import { z } from 'zod'
import { embeddedAsset } from '../../../../src/schema/index.js'

export const schema = z.object({
  image: embeddedAsset({ accept: ['image'] }),
})

type Content = z.infer<typeof schema>

export default ({ content }: { content: Content }) => ({
  html: '<img>',
  css: '',
  js: '',
})
