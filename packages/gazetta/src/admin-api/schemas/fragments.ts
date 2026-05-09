/**
 * Zod schemas for /api/fragments routes. Pattern mirrors pages.ts —
 * single source of truth shared by server (safeParse) and client
 * (z.infer); drift caught at compile time by the client import or
 * at runtime by api-contract.test.ts.
 */
import { z } from 'zod'

/** Summary used in list responses (GET /api/fragments). */
export const FragmentSummarySchema = z.object({
  name: z.string(),
  template: z.string(),
  locales: z.array(z.string()).optional(),
  /** Archive state per design-soft-delete.md Q1 A1. See pages schema. */
  archived: z.boolean().optional(),
  /** Alias target name when archived with aliasOf. */
  aliasOf: z.string().optional(),
})
export type FragmentSummary = z.infer<typeof FragmentSummarySchema>

/** Body for POST /api/fragments (create). */
export const CreateFragmentRequestSchema = z.object({
  /** Fragment name — used as the directory name and identity. Must be non-empty. */
  name: z.string().min(1),
  /** Template name to bind. Must be non-empty. */
  template: z.string().min(1),
})
export type CreateFragmentRequest = z.infer<typeof CreateFragmentRequestSchema>

/** Response for POST /api/fragments (create). */
export const CreateFragmentResponseSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
})
export type CreateFragmentResponse = z.infer<typeof CreateFragmentResponseSchema>
