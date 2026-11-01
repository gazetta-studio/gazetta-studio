/**
 * The principal a verified Gazetta token stands for (design-agent-access.md
 * Q12): the person who approved the login, with their role expanded from
 * today's config, capped to editing.
 *
 * The role is the one the person had when they approved: a token can't
 * re-read their groups, because the CLI passes the login layer with its
 * own credential (a service token, for example). A person moved to
 * another group keeps the old role until their grant is revoked or they
 * log in again; a role whose capabilities change in config takes effect
 * at once.
 */
import { expandRole } from './capabilities.js'
import { capTokenCapabilities } from './token-cap.js'
import type { VerifiedToken } from './tokens/token.js'
import type { Principal, TrustMode } from './types.js'

export function principalFromToken(
  token: VerifiedToken,
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>,
): Principal {
  const browserCapabilities = expandRole(token.role, customRoles) ?? []
  return {
    id: token.id,
    ...(token.email ? { email: token.email } : {}),
    role: token.role,
    trustMode: token.trustMode as TrustMode,
    capabilities: capTokenCapabilities(browserCapabilities),
    browserCapabilities,
    channel: 'token',
    tokenId: token.tokenId,
    grantId: token.grantId,
  }
}
