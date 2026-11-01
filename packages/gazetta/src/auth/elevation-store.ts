/**
 * Elevations (design-agent-access.md Q12, Q17, Q18): a short window in
 * which one grant's tokens may use the capabilities tokens normally
 * can't (publish, delete, restore, approve), for one scope of targets.
 *
 * Records live in `.gazetta/auth/elevations/<grantId>/<id>.json`, so the
 * check on a withheld request is one listing of that grant's folder, and
 * ending one (or revoking the grant) works at once on every instance.
 * The window is fixed at approval; using it never moves `endsAt`.
 */
import { capabilityGrants } from './capabilities.js'
import { stateFolderPath } from '../state-folders.js'
import type { StorageProvider } from '../types.js'

export type ElevationScope = 'non-production' | 'production'

export interface Elevation {
  elevationId: string
  grantId: string
  /** The person who approved it, the grant's person. */
  personId: string
  scope: ElevationScope
  /** The withheld capabilities the person's browser role had at approval. */
  capabilities: string[]
  approvedAt: string
  endsAt: string
}

/**
 * The scope a withheld capability needs on a target (Q17): production
 * publishing always needs the production scope, other publishing the
 * non-production one; anything else follows the target's environment.
 */
export function elevationScopeFor(capability: string, targetEnvironment: string | undefined): ElevationScope {
  if (capability === 'publish:production') return 'production'
  if (capability === 'publish:non-production') return 'non-production'
  return targetEnvironment === 'production' ? 'production' : 'non-production'
}

/** An elevation id names its grant: `<grantId>.<uuid>`. */
function grantOf(elevationId: string): string | null {
  const dot = elevationId.indexOf('.')
  const grantId = dot > 0 ? elevationId.slice(0, dot) : ''
  return /^[\w-]+$/.test(grantId) && /^[\w-]+$/.test(elevationId.slice(dot + 1)) ? grantId : null
}

export interface ElevationStore {
  create(input: {
    grantId: string
    personId: string
    scope: ElevationScope
    capabilities: string[]
    minutes: number
    /** Never past this time (ms): the grant's own expiry. */
    notAfter?: number
  }): Promise<Elevation>
  get(elevationId: string): Promise<Elevation | null>
  /** Whether an active elevation of the grant covers `capability` in `scope`. */
  covers(grantId: string, scope: ElevationScope, capability: string): Promise<boolean>
  end(elevationId: string): Promise<void>
  /** Ends every elevation of a grant (the grant was revoked). */
  endAll(grantId: string): Promise<void>
}

export function createElevationStore(storage: StorageProvider, now: () => number = () => Date.now()): ElevationStore {
  const dir = (grantId: string) => stateFolderPath('auth', 'elevations', grantId)
  const path = (elevationId: string, grantId: string) => `${dir(grantId)}/${elevationId}.json`

  async function read(elevationId: string): Promise<Elevation | null> {
    const grantId = grantOf(elevationId)
    if (!grantId) return null
    const p = path(elevationId, grantId)
    if (!(await storage.exists(p))) return null
    return JSON.parse(await storage.readFile(p)) as Elevation
  }

  return {
    async create({ grantId, personId, scope, capabilities, minutes, notAfter }) {
      const approvedAt = now()
      const elevation: Elevation = {
        elevationId: `${grantId}.${crypto.randomUUID()}`,
        grantId,
        personId,
        scope,
        capabilities,
        approvedAt: new Date(approvedAt).toISOString(),
        endsAt: new Date(Math.min(approvedAt + minutes * 60_000, notAfter ?? Infinity)).toISOString(),
      }
      await storage.writeFile(path(elevation.elevationId, grantId), JSON.stringify(elevation, null, 2), {
        ifNoneMatch: '*',
      })
      return elevation
    },

    get: read,

    async covers(grantId, scope, capability) {
      if (!/^[\w-]+$/.test(grantId) || !(await storage.exists(dir(grantId)))) return false
      for (const entry of await storage.readDir(dir(grantId))) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue
        const elevation = await read(entry.name.slice(0, -'.json'.length))
        if (
          elevation &&
          elevation.scope === scope &&
          Date.parse(elevation.endsAt) > now() &&
          capabilityGrants(elevation.capabilities, capability)
        ) {
          return true
        }
      }
      return false
    },

    async end(elevationId) {
      const grantId = grantOf(elevationId)
      if (grantId) await storage.rm(path(elevationId, grantId))
    },

    async endAll(grantId) {
      if (/^[\w-]+$/.test(grantId)) await storage.rm(dir(grantId))
    },
  }
}
