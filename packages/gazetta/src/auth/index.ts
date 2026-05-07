/**
 * Auth + RBAC barrel export. Imports are stable across cuts;
 * subsequent cuts (forwarded-user, cloudflare-access, etc.) add
 * exports without breaking the existing surface.
 */
export type { AuthRequest, AuthIdentityProvider } from './provider.js'
export type {
  Principal,
  Role,
  RoleMapping,
  TrustMode,
  BuiltInCapability,
} from './types.js'
export { BUILT_IN_ROLES, RESERVED_CAPABILITY_PREFIXES } from './types.js'
export { AuthError, AuthConfigurationError, AuthenticationError, AuthorizationError } from './errors.js'
export { AuthConfigSchema, isReservedPrefix, type AuthConfig } from './config.js'
export { noneAuthProvider, UNKNOWN_ACTOR_ID } from './providers/none.js'
export { createForwardedUserAuthProvider, type ForwardedUserConfig } from './providers/forwarded-user.js'
export { createCloudflareAccessAuthProvider, type CloudflareAccessConfig } from './providers/cloudflare-access.js'
export { createAzureEasyAuthProvider, type AzureEasyAuthConfig } from './providers/azure-easy-auth.js'
export { createAwsCognitoAuthProvider, type AwsCognitoConfig } from './providers/aws-cognito.js'
export { createTailscaleAuthProvider, type TailscaleConfig } from './providers/tailscale.js'
export { ipMatchesAny, parseRule, parseRules, type ParsedRule } from './ip-match.js'
