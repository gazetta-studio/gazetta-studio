/**
 * Path and query parameters shared by the page and fragment routes
 * (pages, fragments, archive, rename, redirects; #1674). Query values
 * stay strings: handlers compare them (`force === 'true'`) as before.
 */
import { z } from 'zod'

/** `:name` — a page or fragment name. */
export const ItemNameParamSchema = z.object({ name: z.string() })

/** `?target=` — the target to read or write; the active source when absent. */
export const TargetQuerySchema = z.object({ target: z.string().optional() })

/** `?target=&locale=` — reads and saves of one locale variant. */
export const ItemLocaleQuerySchema = TargetQuerySchema.extend({ locale: z.string().optional() })

/** `?target=&force=` — `force=true` bypasses a refusal (admin). */
export const ForceQuerySchema = TargetQuerySchema.extend({ force: z.string().optional() })

/** `?target=&onConflict=` — how a create resolves an archived name. */
export const OnConflictQuerySchema = TargetQuerySchema.extend({ onConflict: z.string().optional() })

/** Request id header, passed to hooks. */
export const RequestIdHeaderSchema = z.object({ 'x-request-id': z.string().optional() })

/** `?target=&force=&permanent=` — `permanent=true` deletes instead of archiving. */
export const DeleteQuerySchema = ForceQuerySchema.extend({ permanent: z.string().optional() })

/** Save headers: `If-Match` carries the save version the edit started from. */
export const SaveHeadersSchema = RequestIdHeaderSchema.extend({ 'if-match': z.string().optional() })
