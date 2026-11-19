/**
 * DOMPurify, loaded on first use. On the server it brings in jsdom (about
 * half a second), and every template imports `html` from `gazetta`, so
 * loading it when the package is imported would slow down every template
 * load, including ones that never sanitize.
 *
 * Callers share this one instance: `svg-sanitize.ts` sets and clears
 * global hooks on it.
 */
import { createRequire } from 'node:module'
import type DOMPurifyInstance from 'isomorphic-dompurify'

type DOMPurify = typeof DOMPurifyInstance

let instance: DOMPurify | undefined

export function domPurify(): DOMPurify {
  if (!instance) {
    const mod = createRequire(import.meta.url)('isomorphic-dompurify') as DOMPurify & { default?: DOMPurify }
    instance = mod.default ?? mod
  }
  return instance
}
