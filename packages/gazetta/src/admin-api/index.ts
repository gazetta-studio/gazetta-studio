import { Hono } from 'hono'
import { join } from 'node:path'
import { logger } from 'hono/logger'
import type { StorageProvider, TargetConfig } from '../types.js'
import { scanTemplates } from '../templates-scan.js'
import { memoizeAsync } from '../concurrency.js'
import { createTargetRegistryView } from '../targets.js'
import { createHistoryProvider } from '../history-provider.js'
import { isHistoryEnabled, getHistoryRetention } from '../types.js'
import {
  createSourceContext,
  staticSourceResolver,
  registrySourceResolver,
  type SourceContext,
  type SourceContextResolver,
} from './source-context.js'
import { authMiddleware } from './middleware/auth.js'
import { principalMiddleware } from './middleware/principal.js'
import { auditMiddleware } from './middleware/audit.js'
import { AuthConfigSchema, AuthConfigurationError, buildAuthProvider } from '../auth/index.js'
import {
  AuditConfigSchema,
  AuditConfigurationError,
  createHistoryAuditProvider,
  DEFAULT_AUDIT_CONFIG,
  type AuditConfig,
  type AuditProvider,
} from '../audit/index.js'
import { siteRoutes } from './routes/site.js'
import { pageRoutes } from './routes/pages.js'
import { fragmentRoutes } from './routes/fragments.js'
import { defaultValidatorRegistry } from '../validation/default-registry.js'
import { templateRoutes } from './routes/templates.js'
import { previewRoutes } from './routes/preview.js'
import { publishRoutes } from './routes/publish.js'
import { compareRoutes } from './routes/compare.js'
import { fieldRoutes } from './routes/fields.js'
import { historyRoutes } from './routes/history.js'
import { assetRoutes } from './routes/assets.js'
import { systemRoutes } from './routes/system.js'
import { auditRoutes } from './routes/audit.js'
import { healthRoutes } from './routes/health.js'
import { startCacheStatsLogger } from './cache-stats-logger.js'

export interface AdminAppOptions {
  /**
   * Pre-built SourceContext — preferred when the caller controls source-content
   * resolution (e.g., derived from a TargetRegistry via createSourceContextFromRegistry).
   * When provided, `storage` is optional (the context carries its own).
   */
  source?: SourceContext
  siteDir: string
  /** Fallback source storage when `source` is not provided. */
  storage?: StorageProvider
  /** Directory containing template packages. Defaults to siteDir/templates. */
  templatesDir?: string
  /** Directory containing admin customizations (editors, fields). Defaults to siteDir/admin. */
  adminDir?: string
  /** Production mode — editors/fields are pre-bundled at /admin/editors/*.js */
  production?: boolean
  /** @deprecated Pre-initialized target providers. Pass `targetConfigs` for lazy init. */
  targets?: Map<string, StorageProvider>
  /** Target configurations — providers are initialized lazily on first publish/fetch/compare. */
  targetConfigs?: Record<string, TargetConfig>
  /**
   * Disable the periodic cache-stats logger. Defaults to false (logger
   * runs every 5 minutes). Tests pass true to avoid background timers
   * leaking into the test runtime.
   */
  disableCacheStatsLogger?: boolean
}

type AdminApp = Hono & {
  invalidateTemplatesCache(): void
  /**
   * Drop AdminCache entries for content (page + fragment summaries)
   * across every SourceContext the resolver has built. Called by
   * `gazetta dev`'s file watcher on out-of-band manifest changes
   * (git pull, manual edit, e2e wipes) — those bypass the save
   * handler that would normally invalidate the cache.
   *
   * Production (`gazetta serve`) doesn't have a file watcher;
   * out-of-band changes there are vanishingly rare (manifests are
   * deployed-once artifacts).
   */
  invalidateContentCache(): Promise<void>
}

/**
 * Create an admin API Hono app. Accepts a single options object.
 *
 * Target providers can be supplied either already-initialized via `targets`
 * (legacy), or as configs via `targetConfigs` (lazy init on first use).
 * Exactly one of these is expected when publish/fetch/compare routes are
 * used; both may be present (pre-initialized entries override configs).
 */
export function createAdminApp(opts: AdminAppOptions): AdminApp {
  const app = new Hono()

  app.use(logger())
  // Bearer-token guard (legacy GAZETTA_TOKEN) — orthogonal to
  // upstream-identity extraction. Principal middleware ships
  // below once `source.manifest` is in scope.
  app.use('/api/*', authMiddleware())

  const templatesDir = opts.templatesDir ?? join(opts.siteDir, 'templates')
  const adminDir = opts.adminDir ?? join(opts.siteDir, 'admin')

  // scanTemplates spawns a worker thread per template (jiti import + graph
  // hash). On a 50-template project that's ~5s of CPU on every publish +
  // compare. Memoize at the server lifetime — the CLI's file watcher calls
  // invalidateTemplatesCache() below on any template change.
  //
  // Keyed by (dir, root) as a string; different sites on one server would
  // each get their own cache entry. For now there's only one site per
  // server so a single memoize is enough; swap for a Map<key, Memoized> if
  // we go multi-site per process.
  const cachedScan = memoizeAsync(async () =>
    scanTemplates(templatesDir, opts.siteDir.replace(/[\\/]sites[\\/][^\\/]+$/, '')),
  )
  const scan = (tDir: string, root: string) => (tDir === templatesDir ? cachedScan.get() : scanTemplates(tDir, root))

  // Prefer an externally-provided SourceContext. Fall back to constructing
  // one from opts.storage + opts.siteDir, which is the legacy shape.
  let source: SourceContext
  if (opts.source) {
    source = opts.source
    // Backfill history on the source if the caller didn't supply one —
    // dev bootstrap builds a bare SourceContext and relies on admin-api
    // to wire history per the target's config. Skip when the target's
    // site.config.ts has `history.enabled: false`, or when there's no
    // matching targetConfig (legacy single-storage path).
    if (!opts.source.history) {
      source = { ...opts.source, history: buildHistoryForSource(opts, opts.source) }
    }
  } else {
    if (!opts.storage) {
      throw new Error('createAdminApp: either `source` or `storage` must be provided')
    }
    source = createSourceContext({
      storage: opts.storage,
      siteDir: opts.siteDir,
      history: buildHistoryForLegacySource(opts),
    })
  }

  // Build the per-request source resolver. When target configs are
  // declared, routes honor `?target=<name>` to read from any known
  // target. Providers are initialized lazily so dev startup doesn't
  // pay the cost of connecting every cloud target just to serve the
  // editable local one.
  //
  // Without target configs (tests, single-target setups), the resolver
  // is static — always returns the bootstrap source.
  let resolveSource: SourceContextResolver
  if (opts.targetConfigs && Object.keys(opts.targetConfigs).length > 0) {
    // Start with whatever pre-initialized providers the caller supplied
    // (typically the editable source target from bootstrap). Missing
    // providers are built on demand via lazyInit below.
    const providers = new Map(opts.targets ?? [])
    const registry = createTargetRegistryView(providers, opts.targetConfigs)
    resolveSource = registrySourceResolver({
      registry,
      projectSiteDir: source.projectSiteDir,
      manifest: source.manifest,
      gazettaManifest: source.gazettaManifest,
      // The registry's filesystem targets are already content-rooted
      // (path=./targets/<key>); siteDir on the resolved context is empty.
      siteDir: '',
      lazyInit: async name => {
        const config = opts.targetConfigs![name]
        if (!config) return
        // Storage is already a constructed provider (Path X — operator-facing
        // factory ran at config-eval). Init the connection if the provider
        // exposes one (S3 + Azure use this for connectivity probes).
        const storage = config.storage
        const maybeInit = storage as StorageProvider & { init?: () => Promise<void> }
        if (typeof maybeInit.init === 'function') await maybeInit.init()
        providers.set(name, storage)
      },
      // Build a HistoryProvider per target, honoring the site.config.ts
      // `history` block (enabled/retention). Returns undefined when the
      // target has history turned off — routes no-op on absent provider.
      buildHistory: (name, storage) => {
        const config = opts.targetConfigs![name]
        if (!config || !isHistoryEnabled(config)) return undefined
        return createHistoryProvider({ storage, retention: getHistoryRetention(config) })
      },
    })
  } else {
    resolveSource = staticSourceResolver(source)
  }

  // Validator registry built once per app — Cut 1 ships the 5 reference-
  // existence validators; Cut 2+ extend the default registry.
  const validators = defaultValidatorRegistry()

  // Principal middleware — extracts upstream identity (Cloudflare
  // Access JWT, X-Forwarded-User header, etc.) per the configured
  // trust mode in `site.config.ts admin.auth`. Falls back to
  // `none`-mode (anonymous + admin role) when no auth is configured.
  // Must run before route registration so handlers see c.var.principal.
  //
  // The auth config sits under SiteManifest.admin.auth as a loose
  // record (per the existing config schema's reserved-slot pattern);
  // we strict-parse it here against the typed AuthConfigSchema and
  // throw a clear AuthConfigurationError if the operator's block is
  // malformed.
  const rawAuthBlock = source.manifest?.admin?.auth as unknown
  let authProvider
  if (rawAuthBlock !== undefined) {
    const parsed = AuthConfigSchema.safeParse(rawAuthBlock)
    if (!parsed.success) {
      throw new AuthConfigurationError(
        `Invalid admin.auth block in site.config.ts: ${parsed.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      )
    }
    authProvider = buildAuthProvider(parsed.data)
  } else {
    // No admin.auth block — none mode (single-author / dev).
    authProvider = buildAuthProvider(undefined)
  }
  app.use('/api/*', principalMiddleware(authProvider))

  // Audit middleware — per design-audit.md "Recording timing".
  // Resolves admin.audit config; constructs the configured providers;
  // injects c.var.audit so handlers can call `c.var.audit.record(...)`.
  // Defaults to HistoryAuditProvider when admin.audit is absent
  // (zero-config audit; events stored under target's
  // .gazetta/audit/events-{instance}.jsonl).
  const rawAuditBlock = source.manifest?.admin?.audit as unknown
  let auditConfig: AuditConfig
  if (rawAuditBlock !== undefined) {
    const parsed = AuditConfigSchema.safeParse(rawAuditBlock)
    if (!parsed.success) {
      throw new AuditConfigurationError(
        `Invalid admin.audit block in site.config.ts: ${parsed.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      )
    }
    auditConfig = parsed.data
  } else {
    auditConfig = DEFAULT_AUDIT_CONFIG
  }
  // Salt env var resolution per design-audit.md "Salt management":
  // GAZETTA_AUDIT_ACTOR_SALT for actor pseudonymization;
  // GAZETTA_AUDIT_SOURCEIP_SALT for source-IP hashing.
  const actorPseudonym = auditConfig.actorPseudonym ?? 'none'
  const recordSourceIp = auditConfig.recordSourceIp ?? 'none'
  const recordUserAgent = auditConfig.recordUserAgent ?? 'none'
  if (actorPseudonym === 'sha256' && !process.env.GAZETTA_AUDIT_ACTOR_SALT) {
    throw new AuditConfigurationError(
      'admin.audit.actorPseudonym: sha256 requires the GAZETTA_AUDIT_ACTOR_SALT environment variable',
    )
  }
  if (recordSourceIp === 'hashed' && !process.env.GAZETTA_AUDIT_SOURCEIP_SALT) {
    throw new AuditConfigurationError(
      'admin.audit.recordSourceIp: hashed requires the GAZETTA_AUDIT_SOURCEIP_SALT environment variable',
    )
  }
  // Build the configured providers. v1 ships only HistoryAuditProvider;
  // v2 sinks (webhook, file, OTel, CloudWatch, etc.) extend the build
  // step here when they ship.
  const auditProviders: AuditProvider[] = []
  if (auditConfig.provider === 'history') {
    auditProviders.push(
      createHistoryAuditProvider({
        storage: source.storage,
        instance: process.env.K_REVISION ?? require('node:os').hostname() ?? 'gazetta-admin',
      }),
    )
  }
  app.use(
    '/api/*',
    auditMiddleware({
      providers: auditProviders,
      strict: auditConfig.strict ?? false,
      actorPseudonym,
      actorSalt: process.env.GAZETTA_AUDIT_ACTOR_SALT,
      recordSourceIp,
      sourceIpSalt: process.env.GAZETTA_AUDIT_SOURCEIP_SALT,
      trustedProxyCount: auditConfig.trustedProxyCount,
      recordUserAgent,
    }),
  )

  app.route('/', siteRoutes(resolveSource))
  app.route('/', pageRoutes(resolveSource, validators, templatesDir))
  app.route('/', fragmentRoutes(resolveSource, validators, templatesDir))
  app.route('/', templateRoutes(resolveSource, templatesDir, adminDir, opts.production))
  app.route('/', previewRoutes(resolveSource, templatesDir))
  app.route('/', publishRoutes(resolveSource, opts.targets, opts.targetConfigs, templatesDir, scan))
  app.route('/', compareRoutes(resolveSource, opts.targets, opts.targetConfigs, templatesDir, scan))
  app.route('/', fieldRoutes(resolveSource, adminDir))
  app.route('/', historyRoutes(resolveSource, opts.targets, opts.targetConfigs))
  app.route('/', assetRoutes(resolveSource))
  app.route('/', systemRoutes(resolveSource))
  app.route('/', auditRoutes({ providers: auditProviders }))
  app.route('/', healthRoutes())

  // Periodic cache stats log — fires every 5 minutes against the
  // bootstrap source's cache. Runs unobtrusively (timer.unref()
  // means it never blocks process exit). Tests pass
  // `disableCacheStatsLogger: true` to avoid background timers; the
  // route at /api/system/cache/stats still exposes on-demand
  // snapshots either way.
  if (!opts.disableCacheStatsLogger) {
    startCacheStatsLogger({ cache: source.cache })
  }

  // Exposed for the CLI's template file watcher: clears the memoized scan
  // so the next publish/compare picks up template edits. Not part of the
  // Hono Request interface — the CLI casts the return.
  const appWithInvalidate = app as AdminApp
  appWithInvalidate.invalidateTemplatesCache = () => cachedScan.invalidate()
  appWithInvalidate.invalidateContentCache = async () => {
    await resolveSource.forEachBuilt(async ctx => {
      await Promise.all([ctx.cache.invalidatePrefix('pages:'), ctx.cache.invalidatePrefix('fragments:')])
    })
  }
  return appWithInvalidate
}

/**
 * Build a HistoryProvider for the caller-supplied source. Used when
 * the bootstrap gives us a SourceContext without history pre-wired
 * (dev server, CLI scripts). Picks up the source target's config from
 * `opts.targetConfigs` — respects `history.enabled: false`, honors the
 * configured retention. Returns undefined when we can't identify the
 * target or history is disabled.
 */
function buildHistoryForSource(opts: AdminAppOptions, source: SourceContext) {
  const name = source.targetName
  const config = name ? opts.targetConfigs?.[name] : undefined
  if (!config || !isHistoryEnabled(config)) return undefined
  return createHistoryProvider({
    storage: source.storage,
    retention: getHistoryRetention(config),
  })
}

/**
 * Legacy path: caller passed raw `opts.storage` rather than a
 * SourceContext. No target name is available; default history to
 * enabled with default retention, assuming the common single-target
 * setup. Skipped when targetConfigs is absent — historical behavior
 * (tests that rely on no `.gazetta/` writes happening).
 */
function buildHistoryForLegacySource(opts: AdminAppOptions) {
  const configs = opts.targetConfigs
  if (!configs) return undefined
  // Pick the first editable target's config as the best-effort stand-in.
  // Non-editable targets don't receive saves anyway, so the legacy
  // single-storage path is necessarily an editable one.
  const firstEditable = Object.entries(configs).find(([, c]) => isHistoryEnabled(c))
  if (!firstEditable) return undefined
  return createHistoryProvider({
    storage: opts.storage!,
    retention: getHistoryRetention(firstEditable[1]),
  })
}
