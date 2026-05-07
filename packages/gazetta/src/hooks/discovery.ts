/**
 * Site-local hook discovery — walks `admin/hooks/*.{ts,js}` at admin
 * boot, dynamic-imports each file, registers the named exports
 * matching v1 phase names against the registry.
 *
 * Per design-hooks.md "Discovery (Q4 locked)":
 *
 *   - File pattern: `admin/hooks/*.{ts,js}` (flat or one-level deep
 *     for grouping, e.g., `admin/hooks/audit/cdn-purge.ts` — but v1
 *     ships flat-only; nested support reserved if operators ask)
 *   - One file CAN export multiple phases (e.g., a CDN-purge hook
 *     exports BOTH `afterPublish` AND `afterSave`)
 *   - Optional `meta` export overrides default name / priority /
 *     timeout (file basename + 1000 + 5000 are the defaults per
 *     the convention bands)
 *   - Site-local hooks register at priority 1000 (the convention
 *     band for site-local) so they run AFTER plugin hooks (100-999)
 *     and built-in hooks (0-99). Operators violate the convention
 *     with explicit `meta.priority`.
 *
 * # Why dynamic import (await import) over static glob
 *
 * Discovery happens at admin boot — synchronous module graph isn't
 * an option since the directory contents are runtime data. Static
 * `import.meta.glob` (Vite) doesn't fit because the discovery
 * runs in Node (admin-api), not Vite. `await import()` works in
 * both ESM Node and the bundled admin-api build.
 *
 * # TypeScript imports via jiti
 *
 * Hook files are operator-authored .ts files; node ESM doesn't
 * load .ts directly. We piggy-back on the existing jiti dependency
 * (templates use it) — same pattern, same deps.
 *
 * # SOLID lenses
 *
 *   - SRP: discovery walks files + extracts handlers; doesn't
 *     dispatch (Cut 2's concern), doesn't construct HookContext
 *     (caller's concern), doesn't seal the registry (caller does
 *     that after init).
 *   - DIP: depends on the HookRegistry public surface; doesn't
 *     reach into storage layout.
 *   - OCP: adding a new phase extends `KNOWN_PHASES`; no other
 *     change required (file format unchanged).
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import type { HookRegistry } from './registry.js'
import type { HookHandler, HookOptions, HookPhase } from './types.js'

/**
 * Closed list of v1 phase names a hook file may export.
 * Cut 8 extends with the 10 review-lifecycle phases when the
 * review state machine ships.
 */
const KNOWN_PHASES: ReadonlyArray<HookPhase> = [
  'beforeSave',
  'afterSave',
  'afterLoad',
  'beforePublish',
  'afterPublish',
  'beforeUpload',
  'afterUpload',
]

/**
 * Site-local default priority. Per design-hooks.md "Composition"
 * priority bands: site-local hooks run last (highest priority
 * number) so they see plugin + built-in results.
 */
const SITE_LOCAL_PRIORITY = 1000

/**
 * Optional `meta` export shape. Hook files may export this to
 * override defaults. All fields optional; the discovery falls
 * back to file basename / priority 1000 / timeout 5000.
 */
export interface HookFileMeta {
  /** Human-readable name; defaults to the file basename. */
  name?: string
  /** Override priority; defaults to 1000 (site-local band). */
  priority?: number
  /** Override per-handler timeout (ms); defaults to 5000. */
  timeout?: number
}

/** Result of one discovery pass — for diagnostics + tests. */
export interface DiscoveryResult {
  /** Files visited (relative paths). */
  filesScanned: number
  /** Number of hook handlers registered across all files. */
  handlersRegistered: number
  /** Files that failed to import — surfaced for operator review. */
  errors: Array<{ file: string; error: string }>
}

export interface DiscoverOptions {
  /**
   * Absolute path to the project's `admin/hooks/` directory.
   * Discovery returns immediately when the directory doesn't exist
   * (sites without hooks are common and shouldn't error).
   */
  hooksDir: string
  /** Registry to register handlers against. */
  registry: HookRegistry
}

/**
 * Walk `hooksDir`, import each file, register handlers matching
 * v1 phase names. Sites without an `admin/hooks/` directory get
 * an empty result without error.
 *
 * Order of registration: filesystem order (stable per platform).
 * Within a file, KNOWN_PHASES order (one file with both `beforeSave`
 * and `afterSave` registers in beforeSave-first order).
 */
export async function discoverSiteLocalHooks(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const { hooksDir, registry } = opts
  const result: DiscoveryResult = { filesScanned: 0, handlersRegistered: 0, errors: [] }

  // Use the string-overload explicitly. `readdir(path, { withFileTypes: true })`
  // returns Dirent<NonSharedBuffer> by default in newer @types/node;
  // the encoding option steers to the string-named overload.
  let entries: Array<{ name: string; isFile: () => boolean }>
  try {
    entries = (await readdir(hooksDir, {
      withFileTypes: true,
      encoding: 'utf-8',
    })) as unknown as Array<{ name: string; isFile: () => boolean }>
  } catch (err) {
    // Missing directory = no hooks. Most sites won't have one;
    // surface other I/O errors for operator visibility.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw err
  }

  // Files only (v1 doesn't recurse). Filter to .ts/.tsx/.js/.mjs.
  const files = entries
    .filter(d => d.isFile())
    .filter(d => /\.(ts|tsx|js|mjs)$/.test(d.name))
    .map(d => d.name)
    .sort()

  // One jiti instance shared across all files. moduleCache: true
  // ensures repeated discovery (e.g., dev hot-reload) re-resolves.
  const jiti = createJiti(pathToFileURL(hooksDir).href, { jsx: false, moduleCache: false })

  for (const fileName of files) {
    result.filesScanned++
    const fullPath = join(hooksDir, fileName)
    let mod: Record<string, unknown>
    try {
      mod = (await jiti.import(fullPath)) as Record<string, unknown>
    } catch (err) {
      result.errors.push({ file: fileName, error: (err as Error).message })
      continue
    }

    // Extract optional meta. Validate shape before applying.
    const meta = parseMeta(mod.meta)

    // Default name = file basename without extension.
    const baseName = fileName.replace(/\.(ts|tsx|js|mjs)$/, '')
    const options: HookOptions = {
      name: meta.name ?? baseName,
      priority: meta.priority ?? SITE_LOCAL_PRIORITY,
      timeout: meta.timeout, // undefined → registry default 5000
    }

    // Register every phase the file exports. One file can export
    // multiple phases; each registers as its own handler with the
    // shared meta-derived name (operators wanting per-phase names
    // override via separate files or per-export metadata, deferred).
    for (const phase of KNOWN_PHASES) {
      const handler = mod[phase]
      if (typeof handler !== 'function') continue
      registry.register(phase, handler as HookHandler, options, 'site-local')
      result.handlersRegistered++
    }
  }

  return result
}

/**
 * Parse + validate the optional `meta` export. Bad shapes
 * (`meta: 'hello'`, `meta: { priority: 'bad' }`) silently degrade
 * to defaults rather than failing discovery — one bad meta shouldn't
 * prevent the rest of the file's hooks from registering. Operators
 * see issues via the file's broken behavior + future structured
 * logging.
 */
function parseMeta(value: unknown): HookFileMeta {
  if (typeof value !== 'object' || value === null) return {}
  const obj = value as Record<string, unknown>
  const meta: HookFileMeta = {}
  if (typeof obj.name === 'string') meta.name = obj.name
  if (typeof obj.priority === 'number' && Number.isFinite(obj.priority)) meta.priority = obj.priority
  if (typeof obj.timeout === 'number' && Number.isFinite(obj.timeout) && obj.timeout > 0) {
    meta.timeout = obj.timeout
  }
  return meta
}
