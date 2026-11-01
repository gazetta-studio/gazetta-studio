/**
 * Writes the admin API's OpenAPI document to a file, for generating gz's
 * client (design-agent-access.md Q8). Usage: tsx scripts/openapi-document.ts <out>
 */
import { writeFile } from 'node:fs/promises'
import { openApiDocumentJson } from '../tests/_helpers/openapi-document.js'

const out = process.argv[2]
if (!out) throw new Error('usage: openapi-document.ts <out.json>')
await writeFile(out, await openApiDocumentJson())
