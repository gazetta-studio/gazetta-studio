import { timingSafeEqual } from 'node:crypto'

export function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  // node:crypto's timingSafeEqual throws RangeError on different-length buffers,
  // which itself leaks length via the early control-flow divergence. Compare a
  // length-equalised pair so the comparison always runs full-width, then fold
  // length equality into the result.
  const len = Math.max(aBuf.length, bBuf.length, 1)
  const aPadded = Buffer.alloc(len)
  const bPadded = Buffer.alloc(len)
  aBuf.copy(aPadded)
  bBuf.copy(bPadded)
  const equalBytes = timingSafeEqual(aPadded, bPadded)
  return equalBytes && aBuf.length === bBuf.length
}
