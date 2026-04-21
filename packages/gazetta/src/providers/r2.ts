import type { DirEntry, StorageProvider } from '../types.js'

export interface R2RestProviderOptions {
  accountId: string
  bucket: string
  apiToken: string
}

const CF_API = 'https://api.cloudflare.com/client/v4'

export function createR2RestProvider(options: R2RestProviderOptions): StorageProvider {
  const { accountId, bucket, apiToken } = options
  const base = `${CF_API}/accounts/${accountId}/r2/buckets/${bucket}/objects`

  function headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${apiToken}`, ...extra }
  }

  return {
    async readFile(path: string): Promise<string> {
      const res = await fetch(`${base}/${encodeURIComponent(normalizePath(path))}`, { headers: headers() })
      if (!res.ok) {
        if (res.status === 404) throw new Error(`File not found: ${path}`)
        throw new Error(`Cannot read ${path}: ${res.status} ${res.statusText}`)
      }
      return await res.text()
    },

    async readDir(path: string): Promise<DirEntry[]> {
      const prefix = normalizePath(path)
      const prefixWithSlash = prefix ? `${prefix}/` : ''
      const url = `${CF_API}/accounts/${accountId}/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(prefixWithSlash)}`
      const res = await fetch(url, { headers: headers() })
      if (!res.ok) throw new Error(`Cannot list ${path}: ${res.status}`)
      const data = (await res.json()) as { result: Array<{ key: string }> }
      const entries = new Map<string, boolean>()
      for (const obj of data.result ?? []) {
        const relativeName = obj.key.slice(prefixWithSlash.length)
        const firstSegment = relativeName.split('/')[0]
        if (!firstSegment) continue
        const isDirectory = relativeName.includes('/')
        if (entries.has(firstSegment) && entries.get(firstSegment)) continue
        entries.set(firstSegment, isDirectory)
      }
      return [...entries.entries()].map(([name, isDirectory]) => ({ name, isDirectory }))
    },

    async exists(path: string): Promise<boolean> {
      const res = await fetch(`${base}/${encodeURIComponent(normalizePath(path))}`, {
        method: 'HEAD',
        headers: headers(),
      })
      if (res.ok) return true
      // Check as directory prefix
      const url = `${CF_API}/accounts/${accountId}/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(normalizePath(path) + '/')}&per_page=1`
      const listRes = await fetch(url, { headers: headers() })
      if (!listRes.ok) return false
      const data = (await listRes.json()) as { result: unknown[] }
      return (data.result?.length ?? 0) > 0
    },

    async writeFile(path: string, content: string): Promise<void> {
      const body = new TextEncoder().encode(content)
      const res = await fetch(`${base}/${encodeURIComponent(normalizePath(path))}`, {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'text/plain; charset=utf-8' }),
        body,
      })
      if (!res.ok) throw new Error(`Cannot write ${path}: ${res.status} ${res.statusText}`)
    },

    async mkdir(_path: string): Promise<void> {
      // R2 has no directories — implicit from key prefixes
    },

    async rm(path: string): Promise<void> {
      const key = normalizePath(path)
      // Try deleting as single object
      await fetch(`${base}/${encodeURIComponent(key)}`, { method: 'DELETE', headers: headers() })
      // Delete all objects with this prefix
      const url = `${CF_API}/accounts/${accountId}/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(key)}`
      const listRes = await fetch(url, { headers: headers() })
      if (listRes.ok) {
        const data = (await listRes.json()) as { result: Array<{ key: string }> }
        for (const obj of data.result ?? []) {
          await fetch(`${base}/${encodeURIComponent(obj.key)}`, { method: 'DELETE', headers: headers() })
        }
      }
    },
  }
}

function normalizePath(path: string): string {
  return path.replace(/^(\.\/|\/)+/, '')
}
