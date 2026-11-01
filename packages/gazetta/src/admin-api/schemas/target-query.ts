/**
 * The `?target=` query most admin-API routes take: which configured
 * target the request reads or writes. Omitted means the default editable
 * target; an unknown name is answered by the source resolver.
 */
import { z } from 'zod'

export const TargetQuerySchema = z.object({
  /** The target to read or write; defaults to the editable target. */
  target: z.string().optional(),
})
export type TargetQuery = z.infer<typeof TargetQuerySchema>
