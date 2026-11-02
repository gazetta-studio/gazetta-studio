/**
 * `POST /api/v1/saves`, the bulk save (design-agent-access.md Q46, #1714).
 */
import { z } from '@hono/zod-openapi'
import { isSafeItemName, UNSAFE_ITEM_NAME_MESSAGE } from '../../item-name.js'

export const BulkSaveItemSchema = z
  .object({
    kind: z.enum(['page', 'fragment']),
    name: z.string().refine(isSafeItemName, UNSAFE_ITEM_NAME_MESSAGE),
    locale: z.string().optional(),
    manifest: z
      .record(z.string(), z.unknown())
      .describe("The item's manifest. For an update, fields it leaves out keep their stored values."),
    ifMatch: z.string().optional().describe('The save-version you last read. Every existing item needs one.'),
    ifNoneMatch: z
      .literal('*')
      .optional()
      .describe(
        'Create the item instead: it saves only if nothing exists under its name. With a locale, it creates that language version of an item that exists.',
      ),
  })
  .refine(item => (item.ifMatch === undefined) !== (item.ifNoneMatch === undefined), {
    message: 'Give each item either ifMatch or ifNoneMatch: "*"',
  })
  .meta({ id: 'BulkSaveItem' })

export const BulkSaveRequestSchema = z
  .object({ items: z.array(BulkSaveItemSchema).min(1) })
  .meta({ id: 'BulkSaveRequest' })
export type BulkSaveRequest = z.infer<typeof BulkSaveRequestSchema>

export const BulkSaveResponseSchema = z
  .object({
    ok: z.literal(true),
    revision: z.string().optional().describe('The history revision recording the batch; absent without history.'),
    items: z.array(
      z.object({
        index: z.number().int(),
        kind: z.enum(['page', 'fragment']),
        name: z.string(),
        locale: z.string().optional(),
        etag: z.string().describe('The new save-version, to send as ifMatch next time.'),
      }),
    ),
  })
  .meta({ id: 'BulkSaveResponse' })
