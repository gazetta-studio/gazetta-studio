/**
 * gz's client is generated from a committed copy of the OpenAPI document
 * (design-agent-access.md Q8). This fails when a route changes without
 * regenerating it; the Go suite then checks the client against the copy.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openApiDocumentJson } from './_helpers/openapi-document.js'

const committed = fileURLToPath(new URL('../../../gz/internal/api/openapi.json', import.meta.url))

describe("gz's copy of the OpenAPI document", () => {
  it('matches the routes; regenerate with: npm run gz:api', async () => {
    // Compared as JSON: Biome formats the committed copy.
    expect(JSON.parse(await readFile(committed, 'utf8'))).toEqual(JSON.parse(await openApiDocumentJson()))
  })

  it('names the shared error body once, as a component', async () => {
    const doc = JSON.parse(await openApiDocumentJson()) as {
      components: { schemas: Record<string, unknown> }
    }
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(['Problem']))
  })
})
