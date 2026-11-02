/**
 * The run routes (design-agent-access.md Q48, #1730): what an agent run
 * touched, and reverting it item by item.
 */
import { z } from '@hono/zod-openapi'
import { RUN_ID_PATTERN } from '../../request-origin.js'

export const RunParamSchema = z.object({
  runId: z.string().regex(RUN_ID_PATTERN).describe("The run id the run's writes carried in Gazetta-Run."),
})

const RunItemRef = {
  item: z.string().describe("The run index's name: `pages.home`, `fragments.header:fr`, `assets.hero`."),
  kind: z.enum(['page', 'fragment', 'asset']),
  name: z.string(),
  locale: z.string().optional(),
}

export const RunResponseSchema = z
  .object({
    runId: z.string(),
    items: z.array(
      z.object({
        ...RunItemRef,
        created: z.boolean().describe('The run created it: a revert archives it.'),
        changed: z.boolean().describe('Someone changed it since the run: a revert skips it unless forced.'),
        restorable: z
          .boolean()
          .describe('History still holds its version from before the run, so a revert can put it back.'),
      }),
    ),
  })
  .meta({ id: 'RunResponse' })

export const RevertRunRequestSchema = z
  .object({
    force: z
      .array(z.string())
      .optional()
      .describe('Items (`pages.about`) to revert although they changed since the run.'),
  })
  .meta({ id: 'RevertRunRequest' })

export const RevertRunResponseSchema = z
  .object({
    runId: z.string().describe('The run that was reverted.'),
    revertRun: z.string().describe("The run the revert's own writes belong to; reverting it undoes the revert."),
    items: z.array(
      z.object({
        ...RunItemRef,
        status: z.enum(['reverted', 'archived', 'skipped-changed', 'skipped-in-use', 'skipped-failed']),
        reason: z.string().optional(),
      }),
    ),
  })
  .meta({ id: 'RevertRunResponse' })
