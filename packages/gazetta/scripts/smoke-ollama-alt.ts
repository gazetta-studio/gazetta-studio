/**
 * End-to-end smoke against a real local Ollama instance.
 *
 * Run with:
 *   cd packages/gazetta
 *   npx tsx scripts/smoke-ollama-alt.ts
 *
 * Requires:
 *   - Ollama running at http://localhost:11434
 *   - llama3.2-vision:11b pulled (`ollama pull llama3.2-vision:11b`)
 *
 * Loads a real JPEG, runs the full suggester pipeline (vision-prep,
 * prompt composition, adapter call), prints the result.
 *
 * Not part of CI. CI uses msw-mocked tests for determinism.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createOllamaAltAdapter } from '../src/alt/ollama.js'
import { createAltSuggester } from '../src/alt/suggester.js'

const TEST_IMAGE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'examples',
  'starter',
  'sites',
  'main',
  'targets',
  'local',
  'assets',
  'test-pattern-2092f9b7.jpg',
)

async function main(): Promise<void> {
  console.log(`Loading test image: ${TEST_IMAGE_PATH}`)
  const bytes = new Uint8Array(await readFile(TEST_IMAGE_PATH))
  console.log(`  → ${bytes.byteLength} bytes`)

  console.log()
  console.log('Building Ollama adapter (default model: llama3.2-vision:11b)...')
  const adapter = createOllamaAltAdapter()
  console.log(`  → adapter.name = ${adapter.name}`)
  console.log(`  → adapter.supports('image/jpeg') = ${adapter.supports('image/jpeg')}`)

  console.log()
  console.log('Building suggester...')
  const suggester = createAltSuggester({ adapter })
  console.log(`  → suggester.available('image/jpeg') = ${suggester.available('image/jpeg')}`)

  // English run.
  console.log()
  console.log('Calling suggester.suggest({ locale: "en" })...')
  console.log('  (this may take 5-30s depending on hardware)')
  const startEn = Date.now()
  const resultEn = await suggester.suggest({
    bytes,
    mime: 'image/jpeg',
    hash: '2092f9b7',
    locale: 'en',
  })
  const elapsedEn = Date.now() - startEn
  console.log(`  → completed in ${elapsedEn}ms`)
  console.log()

  if (resultEn === null) {
    console.error('FAIL: suggester returned null')
    process.exit(1)
  }
  console.log('=== English result ===')
  console.log(`  refused:        ${resultEn.refused}`)
  console.log(`  refusalReason:  ${resultEn.refusalReason}`)
  console.log(`  text:           ${JSON.stringify(resultEn.text)}`)
  console.log(`  text length:    ${resultEn.text.length} chars`)

  // French run — exercises the locale-policy branch (Ollama's
  // multilingual quality is the empirical question here).
  console.log()
  console.log('Calling suggester.suggest({ locale: "fr" })...')
  const startFr = Date.now()
  const resultFr = await suggester.suggest({
    bytes,
    mime: 'image/jpeg',
    hash: '2092f9b7',
    locale: 'fr',
  })
  const elapsedFr = Date.now() - startFr
  console.log(`  → completed in ${elapsedFr}ms`)
  console.log()
  if (resultFr === null) {
    console.error('FAIL: French suggester returned null')
    process.exit(1)
  }
  console.log('=== French result ===')
  console.log(`  refused:        ${resultFr.refused}`)
  console.log(`  text:           ${JSON.stringify(resultFr.text)}`)
  console.log(`  text length:    ${resultFr.text.length} chars`)
}

main().catch(err => {
  console.error('ERROR:', err)
  process.exit(1)
})
