/**
 * Page Save — kind-specific wrapper around `saveManifestCore`.
 *
 * Owns the bits unique to Page Manifest writes:
 *   - Locale resolution (default vs `page.{locale}.json` variant)
 *     using `site.pages` + `site.pageLocales`
 *   - Component-ID auto-assignment via `ensureComponentIds`
 *   - Filename composition (`page.json` vs `page.{locale}.json`)
 *   - Manifest assembly (template/content/components/metadata, plus
 *     route preservation for locale variants)
 *   - The `route` field in `etagExtras` (folder-derived; not stored
 *     in the file but part of the etag projection chain per
 *     `design-offline.md` Q3)
 *   - Per-kind cache prefix `pages:`
 *
 * Everything downstream — etag check, validators, beforeSave hooks,
 * history, write, sidecars, cache invalidate, audit, afterSave hooks,
 * scanner — is `saveManifestCore`'s spine. This wrapper is the
 * Page-flavored thin entry point routes (and the future CLI / plugin
 * routes) call.
 *
 * Per Q3 lock: two fns + shared core. The 5 page-specific diffs
 * (route field, locale lookup in `site.pages`, page-cache prefix,
 * filename, route preservation in locale variants) live here in
 * one file the reader can scan top-to-bottom.
 */

import { join } from 'node:path'
import { ensureComponentIds } from '../component-ids.js'
import { deriveRoute } from '../runtime/derive-route.js'
import { isValidLocale } from '../locale.js'
import {
  saveManifestCore,
  type PreparedSave,
  type SaveAuditRecorder,
  type SaveResult,
  type SavePrincipal,
  type SaveSourceWiring,
} from '../manifest-save.js'
import type { PageManifest } from '../types.js'
import { localeVariantRoute, type Site } from '../site-loader.js'
import type { ValidatorRegistry } from '../validation/registry.js'
import type { ValidationScanner } from '../validation/scanner.js'
import type { HookFiringEmitter, HookRegistry } from '../hooks/index.js'

/**
 * Inputs to `savePage`. Routes destructure their request and pass
 * the parts the pipeline needs; CLI / plugin callers do the same
 * without an HTTP shell. Returns one of `SaveResult`'s typed
 * variants — caller projects to HTTP (200 / 409) or CLI exit code.
 */
export interface SavePageInput {
  /** Page name (folder name under `pages/`). */
  readonly name: string
  /** BCP-47 locale when saving a Locale Variant; undefined for default. */
  readonly locale?: string
  /** Incoming manifest body (template/content/components/metadata). */
  readonly body: Partial<PageManifest> & Record<string, unknown>
  /** Optional save-etag for concurrency check. */
  readonly ifMatch?: string
  /**
   * Create the page instead of updating it (the bulk save, #1714): `body`
   * is its whole manifest and nothing may exist at its path. With a locale,
   * it creates that language version of a page that exists.
   */
  readonly create?: boolean
  /** Loaded site (caller does `loadSiteFromSource(source)` once). */
  readonly site: Site
  /** Source wiring (cache, history, storage, contentRoot, manifest, targetName). */
  readonly source: SaveSourceWiring
  /** Authenticated principal driving this save. */
  readonly principal: SavePrincipal
  /** Audit recorder bound to the request. */
  readonly audit: SaveAuditRecorder
  /** Validator registry built once at admin boot. */
  readonly validators: ValidatorRegistry
  /** Hook registry; absent when no hooks contributed. */
  readonly hooks?: HookRegistry
  /** Audit-firing emitter for hook dispatch. */
  readonly hookAuditEmit?: HookFiringEmitter
  /** Background scanner; absent when scanner not enabled. */
  readonly scanner?: ValidationScanner
  /** Per-request correlation id; fresh UUID when absent. */
  readonly requestId?: string
}

/**
 * Page-name-not-found error. The route projects this to a 404; the
 * pipeline can't compose the full save without a `before` manifest
 * (etag check, validators, sidecar diffs all need it). Distinct
 * from the typed `SaveResult` variants because absence-of-target is
 * a route-level precondition, not a save-pipeline outcome.
 */
export class PageNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`Page "${name}" not found`)
    this.name = 'PageNotFoundError'
  }
}

/**
 * Invalid locale code per `isValidLocale`. Routes project to 400.
 */
export class InvalidLocaleError extends Error {
  constructor(public readonly raw: string) {
    super(`Invalid locale code: "${raw}"`)
    this.name = 'InvalidLocaleError'
  }
}

/**
 * Save a Page Manifest. Wraps `saveManifestCore` with the Page-specific
 * resolution + assembly. Throws `PageNotFoundError` / `InvalidLocaleError`
 * for route-level preconditions; returns `SaveResult` for save outcomes.
 *
 * Caller responsibilities:
 *   - Capability check (`requireCapability('edit:pages')`) before calling
 *   - HTTP projection of `SaveResult` (200 success, 409 STALE /
 *     VALIDATION_FAILED / HOOK_CANCELLED with appropriate body shape)
 *   - Setting the `ETag` response header on success from `result.etag`
 */
export async function savePage(input: SavePageInput): Promise<SaveResult> {
  const prepared = await preparePageSave(input)
  if (prepared.ok) return saveManifestCore(prepared.save)
  // Only a create can answer EXISTS, and savePage is never given one.
  if (prepared.code === 'EXISTS') throw new Error(prepared.message)
  return { ok: false, code: 'ARCHIVED', message: prepared.message }
}

/**
 * Resolve and assemble a page save without running it, so the bulk save
 * can check every item before writing any (#1714). Throws
 * `PageNotFoundError` / `InvalidLocaleError` like `savePage`.
 */
export async function preparePageSave(input: SavePageInput): Promise<PreparedSave> {
  // Locale validation — surface invalid codes as a typed error so
  // routes can project to 400 without parsing the message. Mirrors
  // pages.ts:292-294.
  let locale: string | undefined
  if (input.locale !== undefined) {
    if (!isValidLocale(input.locale)) throw new InvalidLocaleError(input.locale)
    locale = input.locale.toLowerCase()
  }

  // Resolve the page to update — locale variant or default. Mirrors
  // pages.ts:300-304. The default page MUST exist (creates go through
  // a separate `createPage` entry point — Cut 5).
  if (input.create) {
    // A new page, or a new language version of one that exists (#1714).
    const defaultPage = input.site.pages.get(input.name)
    let manifestPath: string
    let route: string | undefined
    if (locale) {
      if (!defaultPage) throw new PageNotFoundError(input.name)
      if (defaultPage.archived === true) return { ok: false, code: 'ARCHIVED', message: 'Archived. Restore to edit.' }
      manifestPath = join(defaultPage.dir, `page.${locale}.json`)
      route = localeVariantRoute(input.site.manifest, defaultPage.route, locale)
    } else {
      if (defaultPage) return { ok: false, code: 'EXISTS', message: `Page "${input.name}" already exists` }
      manifestPath = input.source.contentRoot.path('pages', input.name, 'page.json')
      route = deriveRoute(input.name)
    }
    // The stored file decides, also for a language the site's config doesn't list.
    if (await input.source.storage.exists(manifestPath)) {
      return {
        ok: false,
        code: 'EXISTS',
        message: `Page "${input.name}"${locale ? ` (${locale})` : ''} already exists`,
      }
    }
    const manifest: Record<string, unknown> = {
      ...input.body,
      components: ensureComponentIds(input.body.components ?? []),
    }
    // Language versions store their route, as an update does.
    if (locale && route) manifest.route = route
    return {
      ok: true,
      save: {
        ...shared(input),
        kind: 'page',
        name: input.name,
        locale,
        manifest,
        before: null,
        create: true,
        manifestPath,
        cacheInvalidatePrefixes: ['pages:'],
        etagExtras: route === undefined ? {} : { route },
      },
    }
  }

  const defaultPage = input.site.pages.get(input.name)
  if (!defaultPage) throw new PageNotFoundError(input.name)

  // Archived pages are read-only (design-soft-delete.md): refuse
  // before any validation or write. Without this guard the manifest
  // assembly below drops archived/archivedAt/archivedBy/aliasOf and
  // silently un-archives the page (#1340). The archive flags live on
  // the default page, so locale-variant saves are refused too.
  if (defaultPage.archived === true) {
    return { ok: false, code: 'ARCHIVED', message: 'Archived. Restore to edit.' }
  }

  const localeVariant = locale ? input.site.pageLocales.get(input.name)?.locales.get(locale) : undefined
  const page = localeVariant ?? defaultPage

  // Component-ID auto-assignment. Existing IDs preserved; ID-less
  // components get NanoIDs. Per `design-collaboration.md` IDs are the
  // load-bearing anchor for inline comments — running this on every
  // save migrates pre-existing pages without a separate migration
  // step. Mirrors pages.ts:349.
  const components = ensureComponentIds(input.body.components ?? page.components)

  // Manifest assembly — body fields override page fields; route
  // preserved for locale variants (so preview resolution works).
  // Mirrors pages.ts:350-358.
  const manifest: Record<string, unknown> = {
    template: input.body.template ?? page.template,
    content: input.body.content ?? page.content,
    components,
  }
  if (input.body.metadata !== undefined) manifest.metadata = input.body.metadata
  else if (page.metadata) manifest.metadata = page.metadata
  if (input.body.cache !== undefined) manifest.cache = input.body.cache
  else if (page.cache) manifest.cache = page.cache
  // Locale variants store their route for preview resolution
  // A first language version has no route of its own yet: it gets the one
  // the site loader will give it, not the default page's (#1719).
  const route = locale && !localeVariant ? localeVariantRoute(input.site.manifest, page.route, locale) : page.route
  if (locale && route) manifest.route = route

  // Filename + path composition. Default → `page.json`; locale
  // variant → `page.{locale}.json`. Both live in the default page's
  // dir (locale variants don't get their own folder).
  const filename = locale ? `page.${locale}.json` : 'page.json'
  const manifestPath = join(defaultPage.dir, filename)

  // Hand off to the spine. Page-specific extras:
  //   - cacheInvalidatePrefixes: ['pages:'] only (Page Saves don't
  //     dirty fragments)
  //   - etagExtras: { route } — folder-derived, not stored in the
  //     file but part of the etag projection chain
  return {
    ok: true,
    save: {
      kind: 'page',
      name: input.name,
      locale,
      manifest,
      before: page as unknown as Record<string, unknown>,
      manifestPath,
      ifMatch: input.ifMatch,
      site: input.site,
      cacheInvalidatePrefixes: ['pages:'],
      etagExtras: { route },
      beforeEtagExtras: { route: page.route },
      source: input.source,
      audit: input.audit,
      principal: input.principal,
      hookAuditEmit: input.hookAuditEmit,
      validators: input.validators,
      hooks: input.hooks,
      scanner: input.scanner,
      requestId: input.requestId,
    },
  }
}

/** The request and admin wiring every page save passes through unchanged. */
function shared(input: SavePageInput) {
  return {
    ifMatch: input.ifMatch,
    site: input.site,
    source: input.source,
    audit: input.audit,
    principal: input.principal,
    hookAuditEmit: input.hookAuditEmit,
    validators: input.validators,
    hooks: input.hooks,
    scanner: input.scanner,
    requestId: input.requestId,
  }
}
