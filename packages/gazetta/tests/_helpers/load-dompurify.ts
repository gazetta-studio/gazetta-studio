/**
 * Import this in a test file whose tests sanitize HTML or SVG. DOMPurify loads
 * jsdom on first use (src/dompurify.ts), which can take seconds on a busy CI
 * runner and push the file's first test past its timeout. This loads it once
 * per file, in a hook, before the tests run.
 */
import { beforeAll } from 'vitest'
import { domPurify } from '../../src/dompurify.js'

beforeAll(() => {
  domPurify()
})
