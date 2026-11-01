/**
 * The token setup every principal middleware on one server shares
 * (design-agent-access.md Q12, Q25): one set of signing keys, resolved
 * once, so a token issued by `/api/v1` also works on `/preview/*` and the
 * dev server's `/__validation`. Under `gazetta dev` the key is generated,
 * so two separate setups would reject each other's tokens.
 */
import { customRolesFromManifest } from '../auth/index.js'
import { resolveCliLoginKeys, type SigningKeys } from '../auth/tokens/keys.js'
import { isPublicStorage, type SiteManifest, type StorageProvider, type TargetConfig } from '../types.js'
import type { TokenAuth } from './middleware/principal.js'

export function createTokenAuth(opts: {
  trustMode: string
  manifest?: SiteManifest
  /** The editing source's target, when known. */
  sourceTarget?: TargetConfig
  /** Or its storage, to find the target in the manifest. */
  sourceStorage?: StorageProvider
}): TokenAuth {
  const target =
    opts.sourceTarget ?? Object.values(opts.manifest?.targets ?? {}).find(t => t.storage === opts.sourceStorage)
  let keys: Promise<SigningKeys | null> | undefined
  return {
    // Grants live in the source's private `.gazetta/auth/`; a source on
    // public storage would expose them, so login stays off there.
    keys: () =>
      (keys ??= target && isPublicStorage(target) ? Promise.resolve(null) : resolveCliLoginKeys(opts.trustMode)),
    customRoles: customRolesFromManifest(opts.manifest?.admin?.auth),
  }
}
