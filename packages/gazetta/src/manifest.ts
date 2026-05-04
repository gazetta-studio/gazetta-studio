import type { ComponentEntry, FragmentManifest, PageManifest, StorageProvider } from './types.js'

function parseJson(content: string, filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Expected a JSON object in ${filePath}, got ${typeof parsed}`)
    }
    return parsed
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`JSON parse error in ${filePath}: ${err.message}`)
    }
    throw err
  }
}

function parseComponents(raw: unknown): ComponentEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map(entry => {
    if (typeof entry === 'string') return entry
    if (typeof entry === 'object' && entry !== null && typeof entry.template === 'string') {
      const comp = entry as Record<string, unknown>
      return {
        name: comp.name as string,
        template: comp.template as string,
        content: comp.content as Record<string, unknown> | undefined,
        components: parseComponents(comp.components),
      }
    }
    return entry as string
  })
}

export async function parsePageManifest(storage: StorageProvider, filePath: string): Promise<PageManifest> {
  const raw = parseJson(await storage.readFile(filePath), filePath)
  if (typeof raw.template !== 'string') {
    throw new Error(`Invalid page.json at ${filePath}: missing required "template" field`)
  }
  return {
    route: '',
    template: raw.template as string,
    content: raw.content as Record<string, unknown> | undefined,
    components: parseComponents(raw.components),
    metadata: raw.metadata as import('./types.js').PageMetadata | undefined,
    cache: raw.cache as import('./types.js').CacheConfig | undefined,
  }
}

export async function parseFragmentManifest(storage: StorageProvider, filePath: string): Promise<FragmentManifest> {
  const raw = parseJson(await storage.readFile(filePath), filePath)
  if (typeof raw.template !== 'string') {
    throw new Error(`Invalid fragment.json at ${filePath}: missing required "template" field`)
  }
  return {
    template: raw.template,
    content: raw.content as Record<string, unknown> | undefined,
    components: parseComponents(raw.components),
  }
}
