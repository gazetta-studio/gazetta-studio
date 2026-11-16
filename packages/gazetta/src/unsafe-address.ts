/**
 * Whether a plain-text value is an address that would run script when used
 * as a link or image source (design-content-trust.md Q2). The value is read
 * the way a browser reads an `href`: HTML entities decoded, tabs and
 * newlines removed, leading control characters and spaces ignored, the
 * scheme compared case-insensitively.
 */
import { isSafeDataImage } from './safe-data-images.js'

const NAMED_ENTITIES: Record<string, string> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  amp: '&',
  semi: ';',
  sol: '/',
  comma: ',',
  period: '.',
  lpar: '(',
  rpar: ')',
}

function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);?/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** The value as a browser reads it before resolving it as a URL. */
export function normalizeAddress(value: string): string {
  return decodeEntities(value)
    .replace(/[\t\n\r]/g, '')
    .replace(/^[\u0000-\u0020]+/, '')
}

/**
 * The scheme (`javascript:`, `vbscript:`, `data:`) when `value` is an unsafe
 * address, else null. Raster `data:image` URIs of a safe type are allowed.
 */
export function unsafeAddressScheme(value: string): string | null {
  const address = normalizeAddress(value)
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(address)?.[1]?.toLowerCase()
  if (scheme === 'javascript' || scheme === 'vbscript') return `${scheme}:`
  if (scheme === 'data' && !isSafeDataImage(address)) return 'data:'
  return null
}
