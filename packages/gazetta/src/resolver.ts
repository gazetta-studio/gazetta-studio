import type { ResolvedComponent, ComponentEntry, InlineComponent } from './types.js'
import { loadTemplate } from './template-loader.js'
import { processContent } from './content.js'
import { resolveAssetRefs, type AssetResolveContext } from './assets/resolve.js'
import type { Site } from './site-loader.js'
import { resolveLocaleFallback, resolveSiteLocales, type ResolvedLocales } from './locale.js'

/**
 * Build the asset-resolve context from the site being rendered. Shared
 * across all `processContent` + `resolveAssetRefs` pairs in a single
 * resolution pass.
 */
function assetContext(site: Site): AssetResolveContext {
  return { storage: site.storage, assetsRoot: 'assets' }
}

/** Process content: sync transforms (markdown) + async asset resolution. */
async function processAndResolve(
  content: Record<string, unknown> | undefined,
  schema: unknown,
  site: Site,
): Promise<Record<string, unknown> | undefined> {
  const processed = processContent(content, schema)
  return resolveAssetRefs(processed, assetContext(site))
}

interface ResolveContext {
  site: Site
  templatesDir: string
  visited: Set<string>
  path: string[]
  /** When set, fragment references resolve the locale-specific variant first. */
  locale?: string
  /** Resolved site locales — cached for fallback resolution. */
  resolvedLocales?: ResolvedLocales
}

export async function resolveComponent(entry: ComponentEntry, ctx: ResolveContext): Promise<ResolvedComponent> {
  if (typeof entry === 'string') {
    if (!entry.startsWith('@')) {
      throw new Error(
        `Invalid component entry "${entry}" — string entries must be fragment references starting with @.\n` +
          `  Referenced in: ${ctx.path.join(' → ') || 'page root'}`,
      )
    }
    const fragmentName = entry.slice(1)
    return resolveFragmentRef(fragmentName, ctx)
  }

  return resolveInlineComponent(entry, ctx)
}

async function resolveFragmentRef(fragmentName: string, ctx: ResolveContext): Promise<ResolvedComponent> {
  const key = `@${fragmentName}`
  if (ctx.visited.has(key)) {
    throw new Error(`Circular reference detected: ${key}\n` + `  Resolution path: ${ctx.path.join(' → ')} → ${key}`)
  }
  ctx.visited.add(key)
  ctx.path.push(key)

  // Resolve locale-specific fragment variant, falling back through the chain
  let fragment = ctx.site.fragments.get(fragmentName) ?? null
  if (ctx.locale && ctx.resolvedLocales) {
    const localeEntry = ctx.site.fragmentLocales.get(fragmentName)
    if (localeEntry) {
      const available = new Set(localeEntry.locales.keys())
      const bestLocale = resolveLocaleFallback(ctx.locale, available, ctx.resolvedLocales)
      const localeVariant = localeEntry.locales.get(bestLocale)
      if (localeVariant) fragment = localeVariant
    }
  }
  if (!fragment) {
    const available = [...ctx.site.fragments.keys()]
    ctx.path.pop()
    ctx.visited.delete(key)
    throw new Error(
      `Fragment "@${fragmentName}" not found.\n` +
        `  Referenced in: ${ctx.path.join(' → ') || 'page root'}\n` +
        `  Available fragments: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    )
  }

  const loaded = await loadTemplate(ctx.site.storage, ctx.templatesDir, fragment.template)
  const children: ResolvedComponent[] = []
  if (fragment.components) {
    for (const child of fragment.components) {
      children.push(await resolveComponent(child, ctx))
    }
  }

  const treePath = ctx.path.slice(1).join('/')
  ctx.path.pop()
  ctx.visited.delete(key)

  return {
    template: loaded.render,
    content: await processAndResolve(fragment.content, loaded.schema, ctx.site),
    children,
    path: fragment.dir,
    treePath,
  }
}

async function resolveInlineComponent(comp: InlineComponent, ctx: ResolveContext): Promise<ResolvedComponent> {
  const key = comp.name
  if (ctx.visited.has(key)) {
    throw new Error(`Circular reference detected: ${key}\n` + `  Resolution path: ${ctx.path.join(' → ')} → ${key}`)
  }
  ctx.visited.add(key)
  ctx.path.push(comp.name)

  const loaded = await loadTemplate(ctx.site.storage, ctx.templatesDir, comp.template)
  const children: ResolvedComponent[] = []
  if (comp.components) {
    for (const child of comp.components) {
      children.push(await resolveComponent(child, ctx))
    }
  }

  const treePath = ctx.path.slice(1).join('/')
  ctx.path.pop()
  ctx.visited.delete(key)

  return {
    template: loaded.render,
    content: await processAndResolve(comp.content, loaded.schema, ctx.site),
    children,
    treePath,
  }
}

export async function resolveFragment(fragmentName: string, site: Site, locale?: string): Promise<ResolvedComponent> {
  // Resolve locale-specific fragment variant
  let fragment = site.fragments.get(fragmentName) ?? null
  const resolvedLocales = locale ? (resolveSiteLocales(site.manifest) ?? undefined) : undefined
  if (locale && resolvedLocales) {
    const localeEntry = site.fragmentLocales.get(fragmentName)
    if (localeEntry) {
      const available = new Set(localeEntry.locales.keys())
      const bestLocale = resolveLocaleFallback(locale, available, resolvedLocales)
      const localeVariant = localeEntry.locales.get(bestLocale)
      if (localeVariant) fragment = localeVariant
    }
  }
  if (!fragment) {
    const available = [...site.fragments.keys()]
    throw new Error(
      `Fragment "${fragmentName}" not found.\n` +
        `  Available fragments: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    )
  }

  const templatesDir = site.templatesDir
  const ctx: ResolveContext = {
    site,
    templatesDir,
    visited: new Set(),
    path: ['', `@${fragmentName}`],
    locale,
    resolvedLocales,
  }

  const loaded = await loadTemplate(site.storage, templatesDir, fragment.template)
  const children: ResolvedComponent[] = []
  if (fragment.components) {
    for (const child of fragment.components) {
      children.push(await resolveComponent(child, ctx))
    }
  }

  return {
    template: loaded.render,
    content: await processAndResolve(fragment.content, loaded.schema, site),
    children,
    path: fragment.dir,
    treePath: '',
  }
}

export async function resolvePage(pageName: string, site: Site, locale?: string): Promise<ResolvedComponent> {
  const defaultPage = site.pages.get(pageName)
  if (!defaultPage) {
    const available = [...site.pages.keys()]
    throw new Error(
      `Page "${pageName}" not found.\n` +
        `  Available pages: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    )
  }

  // Use locale variant's content/components when available, fall back to default
  const localeEntry = locale ? site.pageLocales.get(pageName) : undefined
  const page = localeEntry?.locales.get(locale!) ?? defaultPage

  const templatesDir = site.templatesDir
  const resolvedLocales = locale ? (resolveSiteLocales(site.manifest) ?? undefined) : undefined
  const ctx: ResolveContext = { site, templatesDir, visited: new Set(), path: [pageName], locale, resolvedLocales }

  const loaded = await loadTemplate(site.storage, templatesDir, page.template)
  const children: ResolvedComponent[] = []
  if (page.components) {
    for (const child of page.components) {
      children.push(await resolveComponent(child, ctx))
    }
  }

  return {
    template: loaded.render,
    content: await processAndResolve(page.content, loaded.schema, site),
    children,
    path: page.dir,
    treePath: '',
  }
}
