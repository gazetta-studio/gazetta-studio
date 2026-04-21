import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import type { DirEntry, StorageProvider } from '../types.js'

export interface AzureBlobProviderOptions {
  connectionString: string
  container: string
}

async function streamToString(readableStream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    readableStream.on('data', (data: Buffer) => chunks.push(data.toString('utf8')))
    readableStream.on('end', () => resolve(chunks.join('')))
    readableStream.on('error', reject)
  })
}

export function createAzureBlobProvider(
  options: AzureBlobProviderOptions,
): StorageProvider & { init(): Promise<void> } {
  const blobServiceClient = BlobServiceClient.fromConnectionString(options.connectionString)
  const containerClient: ContainerClient = blobServiceClient.getContainerClient(options.container)

  return {
    async init() {
      await containerClient.createIfNotExists()
    },

    async readFile(path: string): Promise<string> {
      const blobClient = containerClient.getBlockBlobClient(normalizePath(path))
      try {
        const response = await blobClient.download()
        if (!response.readableStreamBody) throw new Error(`Empty response for ${path}`)
        return await streamToString(response.readableStreamBody)
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 404) throw new Error(`File not found: ${path}`)
        throw new Error(`Cannot read ${path}: ${(err as Error).message}`)
      }
    },

    async readDir(path: string): Promise<DirEntry[]> {
      const prefix = normalizePath(path)
      const prefixWithSlash = prefix ? `${prefix}/` : ''
      const entries = new Map<string, boolean>()

      for await (const blob of containerClient.listBlobsFlat({ prefix: prefixWithSlash })) {
        const relativeName = blob.name.slice(prefixWithSlash.length)
        const firstSegment = relativeName.split('/')[0]
        if (!firstSegment) continue

        const isDirectory = relativeName.includes('/')
        // If we've seen this name as a directory, keep it as directory
        if (entries.has(firstSegment) && entries.get(firstSegment)) continue
        entries.set(firstSegment, isDirectory)
      }

      return [...entries.entries()].map(([name, isDirectory]) => ({ name, isDirectory }))
    },

    async exists(path: string): Promise<boolean> {
      const blobClient = containerClient.getBlockBlobClient(normalizePath(path))
      const exists = await blobClient.exists()
      if (exists) return true

      // Check if it's a "directory" (any blobs with this prefix)
      const prefix = normalizePath(path) + '/'
      for await (const _blob of containerClient.listBlobsFlat({ prefix })) {
        return true
      }
      return false
    },

    async writeFile(path: string, content: string): Promise<void> {
      const blobClient = containerClient.getBlockBlobClient(normalizePath(path))
      await blobClient.upload(content, Buffer.byteLength(content), {
        blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },
      })
    },

    async mkdir(_path: string): Promise<void> {
      // Azure Blob has no directories — they're implicit from blob name prefixes.
      // Nothing to do.
    },

    async rm(path: string): Promise<void> {
      const normalized = normalizePath(path)
      // Try deleting as a single blob
      const blobClient = containerClient.getBlockBlobClient(normalized)
      if (await blobClient.exists()) {
        await blobClient.delete()
        return
      }
      // Delete all blobs with this prefix (directory-like delete)
      const prefix = normalized + '/'
      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        await containerClient.getBlockBlobClient(blob.name).delete()
      }
    },
  }
}

function normalizePath(path: string): string {
  // Remove leading slashes and ./ prefixes
  return path.replace(/^(\.\/|\/)+/, '')
}
