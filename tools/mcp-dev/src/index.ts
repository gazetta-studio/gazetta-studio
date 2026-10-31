import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { chromium, type Browser, type Page } from 'playwright'
import { resolve } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'

const server = new McpServer({ name: 'dev', version: '0.0.2' })

let browser: Browser | null = null
let page: Page | null = null
const tmpDir = resolve(process.cwd(), '.tmp')

async function getPage(width = 1440, height = 900): Promise<Page> {
  if (!browser) browser = await chromium.launch()
  if (!page || page.isClosed()) {
    page = await browser.newPage({ viewport: { width, height } })
  }
  return page
}

/** Resolve selector: data-testid first, CSS fallback */
function sel(testId: string, selector?: string): string {
  return selector ?? `[data-testid="${testId}"]`
}

// ---- Navigation ----

server.tool(
  'goto',
  'Navigate to a URL. Page stays open for subsequent interactions.',
  { url: z.string().describe('Full URL or local path like /admin') },
  async ({ url }) => {
    const fullUrl = url.startsWith('http') ? url : `http://localhost:3000${url}`
    const p = await getPage()
    try {
      await p.goto(fullUrl, { waitUntil: 'load', timeout: 15000 })
      return { content: [{ type: 'text' as const, text: `Navigated to ${fullUrl}` }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Navigation failed: ${(err as Error).message}` }] }
    }
  },
)

// ---- Interactions ----

server.tool(
  'click',
  'Click an element by data-testid (primary) or CSS selector (fallback).',
  {
    testId: z.string().describe('data-testid value'),
    selector: z.string().optional().describe('CSS selector fallback (for elements without a data-testid)'),
  },
  async ({ testId, selector }) => {
    const p = await getPage()
    try {
      await p.click(sel(testId, selector), { timeout: 5000 })
      return { content: [{ type: 'text' as const, text: `Clicked ${testId}` }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Click failed: ${(err as Error).message}` }] }
    }
  },
)

server.tool(
  'type',
  'Type text into an input by data-testid.',
  {
    testId: z.string().describe('data-testid value'),
    text: z.string().describe('Text to type'),
    clear: z.boolean().optional().default(false).describe('Clear input before typing'),
  },
  async ({ testId, text, clear }) => {
    const p = await getPage()
    try {
      if (clear) await p.fill(sel(testId), text)
      else await p.type(sel(testId), text)
      return { content: [{ type: 'text' as const, text: `Typed "${text}" into ${testId}` }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Type failed: ${(err as Error).message}` }] }
    }
  },
)

server.tool(
  'hover',
  'Hover over an element by data-testid.',
  { testId: z.string().describe('data-testid value') },
  async ({ testId }) => {
    const p = await getPage()
    try {
      await p.hover(sel(testId), { timeout: 5000 })
      return { content: [{ type: 'text' as const, text: `Hovered ${testId}` }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Hover failed: ${(err as Error).message}` }] }
    }
  },
)

// ---- Waiting ----

server.tool(
  'wait',
  'Wait for an element with data-testid to appear.',
  {
    testId: z.string().describe('data-testid value'),
    timeout: z.number().optional().default(5000).describe('Timeout in ms'),
  },
  async ({ testId, timeout }) => {
    const p = await getPage()
    try {
      await p.waitForSelector(sel(testId), { state: 'visible', timeout })
      return { content: [{ type: 'text' as const, text: `Found ${testId}` }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Wait failed: ${(err as Error).message}` }] }
    }
  },
)

// ---- Reading (cheap, no vision cost) ----

server.tool(
  'get_text',
  'Read text content of an element by data-testid. Cheap — no vision tokens.',
  { testId: z.string().describe('data-testid value') },
  async ({ testId }) => {
    const p = await getPage()
    try {
      const text = await p.textContent(sel(testId), { timeout: 5000 })
      return { content: [{ type: 'text' as const, text: text ?? '(empty)' }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `get_text failed: ${(err as Error).message}` }] }
    }
  },
)

server.tool(
  'get_attribute',
  'Read an attribute value of an element. Cheap — no vision tokens.',
  {
    testId: z.string().describe('data-testid value'),
    attribute: z.string().describe('Attribute name (e.g. "class", "aria-checked")'),
  },
  async ({ testId, attribute }) => {
    const p = await getPage()
    try {
      const value = await p.getAttribute(sel(testId), attribute, { timeout: 5000 })
      return { content: [{ type: 'text' as const, text: value ?? '(null)' }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `get_attribute failed: ${(err as Error).message}` }] }
    }
  },
)

server.tool(
  'get_aria',
  'Return the full page ARIA accessibility tree as YAML. Cheap — no vision tokens. Great for verifying page structure.',
  {},
  async () => {
    const p = await getPage()
    try {
      const snapshot = await p.ariaSnapshot()
      return { content: [{ type: 'text' as const, text: snapshot }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `get_aria failed: ${(err as Error).message}` }] }
    }
  },
)

// ---- Screenshot (expensive — use sparingly) ----

server.tool(
  'screenshot',
  'Take a screenshot of the current page state. EXPENSIVE — uses vision tokens. Prefer get_text/get_aria for verification. Use only for visual quality checks.',
  {
    url: z.string().optional().describe('Navigate to URL first (optional — omit to capture current state)'),
    width: z.number().optional().default(1440).describe('Viewport width'),
    height: z.number().optional().default(900).describe('Viewport height'),
    fullPage: z.boolean().optional().default(true).describe('Capture full page'),
  },
  async ({ url, width, height, fullPage }) => {
    const p = await getPage(width, height)

    try {
      if (url) {
        const fullUrl = url.startsWith('http') ? url : `http://localhost:3000${url}`
        await p.goto(fullUrl, { waitUntil: 'load', timeout: 15000 })
      }
      const buffer = await p.screenshot({ fullPage, type: 'jpeg', quality: 80 })

      await mkdir(tmpDir, { recursive: true })
      const filename = `screenshot-${Date.now()}.jpg`
      await writeFile(resolve(tmpDir, filename), buffer)

      return {
        content: [
          { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/jpeg' as const },
          { type: 'text' as const, text: `Screenshot saved to .tmp/${filename}` },
        ],
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Screenshot failed: ${(err as Error).message}` }],
      }
    }
  },
)

// ---- Server ----

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Gazetta dev MCP server running (v0.0.2 — with browser interactions)')
}

main().catch(err => {
  console.error('MCP server error:', err)
  process.exit(1)
})

process.on('SIGINT', async () => {
  if (browser) await browser.close()
  process.exit(0)
})
