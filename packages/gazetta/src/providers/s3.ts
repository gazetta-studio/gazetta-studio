import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { Readable } from 'node:stream'
import type { ByteRange, DirEntry, StorageProvider } from '../types.js'
import { nodeReadableToWeb, webReadableToNode } from './_stream-interop.js'

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
      // Encode to Buffer so the SDK sees a known length and skips the
      // "Stream of unknown length" warning. Same wire bytes either way —
      // strings get UTF-8-encoded by the SDK on the way out, we're just
      // doing it ourselves to make the length explicit.
      const body = Buffer.from(content, 'utf-8')
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: normalizePath(path),
          Body: body,
          ContentLength: body.length,
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

    async readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
      const Key = normalizePath(path)
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key,
            // RFC 9110 §14.1.2 — inclusive bytes range. Same semantics as `ByteRange`.
            Range: range ? `bytes=${range.start}-${range.end}` : undefined,
          }),
        )
        if (!response.Body) throw new Error(`Empty body for ${path}`)
        // In Node runtime the SDK returns Body as a Node Readable. The
        // browser/edge build returns a web ReadableStream. We only run
        // server-side (publish, dev-server, gazetta serve) — Node Readable
        // is the deterministic path. Bridge to the lib-dom global so
        // callers see one type regardless of provider.
        return nodeReadableToWeb(response.Body as Readable)
      } catch (err: unknown) {
        const code = (err as { name?: string }).name
        if (code === 'NoSuchKey') throw new Error(`File not found: ${path}`)
        throw new Error(`Cannot read stream from ${path}: ${(err as Error).message}`)
      }
    },

    async writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
      const Key = normalizePath(path)
      try {
        // `Upload` is a hybrid — single-PUT below `partSize` (default 5 MiB),
        // multipart above. Memory bound is `partSize × queueSize` (default
        // 5 MiB × 4 = 20 MiB) regardless of total bytes, so a 4 GB video
        // upload doesn't OOM. `abortOnFailure: true` (default) calls
        // AbortMultipartUpload on error so we don't leak orphan parts.
        const upload = new Upload({
          client,
          params: {
            Bucket: bucket,
            Key,
            Body: webReadableToNode(stream),
          },
        })
        await upload.done()
      } catch (err) {
        throw new Error(`Cannot write stream to ${path}: ${(err as Error).message}`)
      }
    },
  }
}

function normalizePath(path: string): string {
  return path.replace(/^(\.\/|\/)+/, '')
}
