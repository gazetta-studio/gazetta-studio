/**
 * Cost of `processContent` (Markdown conversion + sanitizing) across the
 * 5K-page synthetic site, each inline component carrying a Markdown and a
 * rich-text field (design-content-trust.md, Scale check). Reported, not gated.
 *
 * Vitest 5 has no `bench`, so this is a script: `npx tsx tests/content-sanitize.bench.ts`.
 */
import { z } from 'zod'
import { processContent } from '../src/content.js'
import { format } from '../src/formats.js'
import { buildSyntheticSite } from './_helpers/synthetic-site.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const PAGES = 5000
const storage = memoryStorage()
await buildSyntheticSite(storage, { pageCount: PAGES })

const schema = z.object({
  title: z.string(),
  body: z.string().meta(format.markdown()),
  rich: z.string().meta(format.richtext()),
  items: z.array(z.object({ text: z.string().meta(format.markdown()) })),
})

const BODY = '## Heading\n\nSome *emphasis*, **strong**, a [link](/about) and ![img](/a.png).\n\n- one\n- two\n'
const RICH = '<p>Rich <strong>text</strong> with <a href="/x" target="_blank" rel="noopener">a link</a>.</p>'

const contents: Record<string, unknown>[] = []
for (let i = 0; i < PAGES; i++) {
  const page = JSON.parse(await storage.readFile(`pages/page-${i}/page.json`)) as { components: unknown[] }
  for (const c of page.components) {
    if (typeof c !== 'object' || c === null) continue
    const content = (c as { content?: Record<string, unknown> }).content ?? {}
    contents.push({ ...content, body: BODY, rich: RICH, items: [{ text: '*a*' }, { text: '*b*' }] })
  }
}

const RUNS = 3
processContent(contents[0], schema, 'bench')
const times: number[] = []
for (let run = 0; run < RUNS; run++) {
  const start = performance.now()
  for (const content of contents) processContent(content, schema, 'bench')
  times.push(performance.now() - start)
}
const mean = times.reduce((a, b) => a + b, 0) / RUNS
console.log(
  `processContent across ${PAGES} pages (${contents.length} components): ` +
    `mean ${mean.toFixed(0)} ms per pass, ${((mean * 1000) / contents.length).toFixed(0)} µs per component ` +
    `(runs: ${times.map(t => t.toFixed(0)).join(', ')} ms)`,
)
