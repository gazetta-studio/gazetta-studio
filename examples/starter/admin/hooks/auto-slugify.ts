/**
 * Example site-local hook: auto-fill `metadata.slug` on save when
 * the author hasn't set one explicitly.
 *
 * Returned by a factory function so it composes with `admin.hooks`
 * the same way npm-distributed plugins do — see docs/hooks.md.
 */
import type { BeforeSaveHook, HookContribution } from 'gazetta'

const beforeSave: BeforeSaveHook = async (scope, payload, _ctx) => {
  // Pages only — fragments and assets don't carry routes.
  if (scope.kind !== 'page') return payload
  const p = payload as { metadata?: { slug?: string; title?: string } }
  // Respect operator intent: never overwrite an explicit slug.
  if (p.metadata?.slug) return payload
  const title = p.metadata?.title
  if (!title) return payload
  return {
    ...p,
    metadata: { ...(p.metadata ?? {}), slug: slugify(title) },
  }
}

export function autoSlugify(): HookContribution {
  return {
    source: 'site-local:auto-slugify',
    hooks: [{ phase: 'beforeSave', handler: beforeSave, options: { name: 'auto-slugify' } }],
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
