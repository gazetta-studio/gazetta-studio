/**
 * Zod schemas for `POST /api/page-redirects` + `POST /api/fragment-redirects`
 * — single source of truth for request / response shapes per MCP discipline
 * (see feature-design-process.md non-foundational disciplines).
 *
 * Per `design-redirect-ui.md` Q2 lock: parallel routes (one per kind)
 * carry the capability gate inline; the request body is kind-agnostic
 * (`{ from, to }`). The response shape includes the kind so admin clients
 * have everything they need without re-deriving it from the URL.
 */
import { z } from 'zod'

/**
 * Body for both `POST /api/page-redirects` and `POST /api/fragment-redirects`.
 * Kind is inferred from the route prefix (NOT the body) per Q2 lock —
 * keeps each handler single-purpose + each route's capability gate
 * literal (`requireCapability('edit:pages')` / `'edit:fragments'`).
 *
 * Normalization (Q4 lock) happens server-side:
 *   - Strip leading `/`
 *   - Convert `:param` → `[param]` (Hono route syntax → Gazetta name syntax)
 *
 * Edge-case rejections after normalization:
 *   - `from === 'home'` → 400 INVALID (would redirect site root; deferred)
 *   - normalized `from` contains `[...]` wildcard → 400 INVALID
 */
export const CreateRedirectRequestSchema = z.object({
  /** URL or name that should redirect. Accepts `/old-products` or `old-products`. */
  from: z.string().min(1),
  /** Live page or fragment name to redirect to. */
  to: z.string().min(1),
})
export type CreateRedirectRequest = z.infer<typeof CreateRedirectRequestSchema>

/**
 * Successful redirect-creation response (HTTP 201). Includes:
 *   - normalized `from` (the name that's now archived with `aliasOf`)
 *   - target `to`
 *   - `kind` so client doesn't have to introspect the URL
 *   - `route` / `targetRoute` precomputed via `deriveRoute` (pages only;
 *     fragments emit the bare name for consistency)
 */
export const CreateRedirectResponseSchema = z.object({
  ok: z.literal(true),
  from: z.string(),
  to: z.string(),
  kind: z.enum(['page', 'fragment']),
  route: z.string(),
  targetRoute: z.string(),
})
export type CreateRedirectResponse = z.infer<typeof CreateRedirectResponseSchema>
