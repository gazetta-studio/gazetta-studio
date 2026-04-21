import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3'
import type { DirEntry, StorageProvider } from '../types.js'

export interface S3ProviderOptions {
  endpoint: string
  region?: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}

export function createS3Provider(options: S3ProviderOptions): StorageProvider & { init(): Promise<void> } {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region ?? 'auto',
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    forcePathStyle: options.forcePathStyle ?? true,
  })
  const bucket = options.bucket

  return {
    async init() {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }))
      } catch (err: unknown) {
        const code = (err as { name?: string }).name
        if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
          // Ignore — bucket may already exist
        }
      }
    },

    async readFile(path: string): Promise<string> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: normalizePath(path) }))
        return await response.Body!.transformToString('utf-8')
      } catch (err: unknown) {
        const code = (err as { name?: string }).name
        if (code === 'NoSuchKey') throw new Error(`File not found: ${path}`)
        throw new Error(`Cannot read ${path}: ${(err as Error).message}`)
      }
    },

    async readDir(path: string): Promise<DirEntry[]> {
      const prefix = normalizePath(path)
      const prefixWithSlash = prefix ? `${prefix}/` : ''
      const entries = new Map<string, boolean>()

      // Paginate — S3/R2 returns max 1000 keys per call
      let continuationToken: string | undefined
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefixWithSlash,
            ContinuationToken: continuationToken,
          }),
        )

        for (const obj of response.Contents ?? []) {
          const relativeName = obj.Key!.slice(prefixWithSlash.length)
          const firstSegment = relativeName.split('/')[0]
          if (!firstSegment) continue
          const isDirectory = relativeName.includes('/')
          if (entries.has(firstSegment) && entries.get(firstSegment)) continue
          entries.set(firstSegment, isDirectory)
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)

      return [...entries.entries()].map(([name, isDirectory]) => ({ name, isDirectory }))
    },

    async exists(path: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: normalizePath(path) }))
        return true
      } catch {
        // Check if it's a "directory"
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: normalizePath(path) + '/',
            MaxKeys: 1,
          }),
        )
        return (response.Contents?.length ?? 0) > 0
      }
    },

    async writeFile(path: string, content: string): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: normalizePath(path),
          Body: content,
          ContentType: 'text/plain; charset=utf-8',
        }),
      )
    },

    async mkdir(_path: string): Promise<void> {
      // S3 has no directories — implicit from key prefixes
    },

    async rm(path: string): Promise<void> {
      const prefix = normalizePath(path)
      // Try deleting as a single object first
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: prefix }))
      } catch {
        /* ignore */
      }
      // Delete all objects with this prefix
      const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
      for (const obj of response.Contents ?? []) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key! }))
      }
    },
  }
}

function normalizePath(path: string): string {
  return path.replace(/^(\.\/|\/)+/, '')
}
