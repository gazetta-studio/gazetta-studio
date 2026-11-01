/**
 * Zod schema for `GET /api/version` (design-agent-access.md Q43): the API
 * majors this admin serves, and its exact `gazetta` version for a caller
 * that's signed in.
 */
import { z } from 'zod'

export const VersionResponseSchema = z.object({
  /** Supported majors, newest last, such as `["v1"]`. */
  majors: z.array(z.string()),
  /**
   * The exact `gazetta` version. Only for a signed-in caller: shown to
   * anyone, it tells attackers which known flaws apply (Directus,
   * CVE-2025-53887).
   */
  version: z.string().optional(),
})

export type VersionResponse = z.infer<typeof VersionResponseSchema>
