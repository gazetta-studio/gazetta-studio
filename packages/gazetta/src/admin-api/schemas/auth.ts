/**
 * Zod schemas for CLI login (design-agent-access.md Q12, Q16, Q21):
 * start a login, show and decide it in the browser, redeem it for a grant
 * and a token, renew a token, revoke a grant.
 */
import { z } from 'zod'

export const StartLoginRequestSchema = z.object({
  /** The machine name, as the client reports it. Shown on the approve page. */
  machine: z.string().min(1).max(200),
})

export const StartLoginResponseSchema = z.object({
  /** The code the person checks on the approve page, `ABCD-EFGH`. */
  code: z.string(),
  /** Where the person approves the login, in the admin. */
  approveUrl: z.string(),
  /** The client's secret for redeeming; never shown to the person. */
  pollSecret: z.string(),
  expiresAt: z.string(),
})

export const LoginCodeParamSchema = z.object({ code: z.string() })

/** What the approve page shows (Q21). */
export const LoginDetailsResponseSchema = z.object({
  code: z.string(),
  machine: z.string(),
  ip: z.string().optional(),
  startedAt: z.string(),
  expiresAt: z.string(),
  state: z.enum(['pending', 'approved', 'denied']),
})

export const LoginDecisionResponseSchema = z.object({ state: z.enum(['approved', 'denied']) })

export const RedeemLoginRequestSchema = z.object({ pollSecret: z.string().min(1) })

const TokenFields = {
  /** Send it in the `Gazetta-Token` header. */
  token: z.string(),
  /** Seconds since the epoch. */
  expiresAt: z.number(),
}

export const RedeemLoginResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('approved'),
    grantId: z.string(),
    /** Renews tokens through `POST /auth/tokens`; keep it in the OS keychain. */
    grantSecret: z.string(),
    ...TokenFields,
  }),
])

export const RenewTokenRequestSchema = z.object({ grantSecret: z.string().min(1) })
export const TokenResponseSchema = z.object(TokenFields)

export const GrantParamSchema = z.object({ id: z.string() })

export type StartLoginResponse = z.infer<typeof StartLoginResponseSchema>
export type LoginDetailsResponse = z.infer<typeof LoginDetailsResponseSchema>
export type RedeemLoginResponse = z.infer<typeof RedeemLoginResponseSchema>
