/**
 * `AssetRef` — a single reference record emitted by the ref scanner.
 *
 * Domain concept (where content references an asset), not transport
 * concept (how it moves over HTTP). Lives in the asset domain because:
 *
 * - The ref scanner produces these
 * - The delete orchestrator consumes them (to decide refuse vs remove)
 * - A future usage panel will consume them (same shape, different UI)
 *
 * Zod schema + inferred type in one place — single source of truth. The
 * admin-api's transport schemas import this and wrap it in HTTP-shaped
 * envelopes (e.g. `AssetInUseResponse`); the admin client's types derive
 * from those envelopes. No hand-written parallel interface anywhere.
 */
import { z } from 'zod'

/**
 * Where a ref was found. Stable across pages and fragments so any
 * consumer (usage panel, delete dialog, CLI report) renders uniformly.
 *
 * - `path` is the content-root-relative manifest path
 *   (e.g. `"pages/home/page.json"`).
 * - `componentPath` is a dotted breadcrumb into the manifest's content
 *   tree (`"hero"`, `"banner.image"`, `"gallery[0].photo"`), or `null`
 *   when the ref sits at the manifest's top-level content. `null` means
 *   "the manifest root" — no sentinel string to compare against.
 */
export const AssetRefSchema = z.object({
  source: z.enum(['page', 'fragment']),
  path: z.string(),
  componentPath: z.string().nullable(),
})

export type AssetRef = z.infer<typeof AssetRefSchema>
