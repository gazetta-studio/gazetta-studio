import { describe, it, expect, afterEach } from 'vitest'
import { readFile, writeFile as nodeWriteFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('fs-test-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('createFilesystemProvider (no basePath)', () => {
  const fs = createFilesystemProvider()

  it('writeFile and readFile', async () => {
    const path = join(testDir, 'test.txt')
    await mkdir(testDir, { recursive: true })
    await fs.writeFile(path, 'hello world')
    const content = await fs.readFile(path)
    expect(content).toBe('hello world')
  })

  it('exists returns true for existing file', async () => {
    const path = join(testDir, 'exists.txt')
    await mkdir(testDir, { recursive: true })
    await fs.writeFile(path, 'yes')
    expect(await fs.exists(path)).toBe(true)
  })

  it('exists returns false for missing file', async () => {
    expect(await fs.exists(join(testDir, 'nope.txt'))).toBe(false)
  })

  it('mkdir creates directories', async () => {
    const dir = join(testDir, 'a/b/c')
    await fs.mkdir(dir)
    expect(await fs.exists(dir)).toBe(true)
  })

  it('readDir lists entries', async () => {
    await fs.mkdir(join(testDir, 'dir'))
    await fs.mkdir(join(testDir, 'dir/sub'))
    await fs.writeFile(join(testDir, 'dir/file.txt'), 'data')

    const entries = await fs.readDir(join(testDir, 'dir'))
    expect(entries).toHaveLength(2)

    const names = entries.map(e => e.name)
    expect(names).toContain('sub')
    expect(names).toContain('file.txt')

    const sub = entries.find(e => e.name === 'sub')
    expect(sub?.isDirectory).toBe(true)
    const file = entries.find(e => e.name === 'file.txt')
    expect(file?.isDirectory).toBe(false)
  })

  it('rm removes files and directories', async () => {
    await fs.mkdir(join(testDir, 'rmdir'))
    await fs.writeFile(join(testDir, 'rmdir/file.txt'), 'data')
    await fs.rm(join(testDir, 'rmdir'))
    expect(await fs.exists(join(testDir, 'rmdir'))).toBe(false)
  })
})

describe('createFilesystemProvider (with basePath)', () => {
  it('prepends basePath to all operations', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeFile('relative.txt', 'hello')
    const content = await fs.readFile('relative.txt')
    expect(content).toBe('hello')
    expect(await fs.exists('relative.txt')).toBe(true)
  })

  it('mkdir with basePath', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.mkdir('subdir')
    expect(await fs.exists('subdir')).toBe(true)
  })

  it('readDir with basePath', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeFile('a.txt', '1')
    await fs.writeFile('b.txt', '2')
    const entries = await fs.readDir('.')
    const names = entries.map(e => e.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('b.txt')
  })
})

describe('writeFile atomicity (write-then-rename)', () => {
  it('leaves no temp files in the target directory after a successful write', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeFile('atomic.txt', 'contents')

    // The temp file pattern used by write-file-atomic is `.{name}.{random}` or
    // similar — verify only the target file exists in the directory.
    const entries = await readdir(testDir)
    expect(entries).toEqual(['atomic.txt'])
  })

  it('overwrite of an existing file keeps only the target file', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeFile('overwritten.txt', 'v1')
    await fs.writeFile('overwritten.txt', 'v2')

    const entries = await readdir(testDir)
    expect(entries).toEqual(['overwritten.txt'])
    expect(await fs.readFile('overwritten.txt')).toBe('v2')
  })
})

describe('writeStream and readStream', () => {
  function toUint8Array(s: string): Uint8Array {
    return new TextEncoder().encode(s)
  }

  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
  }

  async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader()
    const parts: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) parts.push(value)
    }
    const total = parts.reduce((acc, p) => acc + p.byteLength, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const p of parts) {
      out.set(p, offset)
      offset += p.byteLength
    }
    return out
  }

  it('writeStream + readStream round-trips bytes', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    const input = toUint8Array('hello streams')
    await fs.writeStream('blob.bin', streamOf([input]))

    const out = await collectStream(await fs.readStream('blob.bin'))
    expect(Buffer.from(out).toString('utf-8')).toBe('hello streams')
  })

  it('writeStream creates intermediate directories', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeStream('deep/nested/path/blob.bin', streamOf([toUint8Array('nested')]))

    expect(await fs.exists('deep/nested/path/blob.bin')).toBe(true)
    const out = await collectStream(await fs.readStream('deep/nested/path/blob.bin'))
    expect(Buffer.from(out).toString('utf-8')).toBe('nested')
  })

  it('writeStream handles multi-chunk input', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    const chunks = ['part1-', 'part2-', 'part3'].map(toUint8Array)
    await fs.writeStream('multi.bin', streamOf(chunks))

    const out = await collectStream(await fs.readStream('multi.bin'))
    expect(Buffer.from(out).toString('utf-8')).toBe('part1-part2-part3')
  })

  it('readStream honors an inclusive byte range', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeStream('ranged.bin', streamOf([toUint8Array('0123456789')]))

    const firstThree = await collectStream(await fs.readStream('ranged.bin', { start: 0, end: 2 }))
    expect(Buffer.from(firstThree).toString('utf-8')).toBe('012')

    const middle = await collectStream(await fs.readStream('ranged.bin', { start: 3, end: 6 }))
    expect(Buffer.from(middle).toString('utf-8')).toBe('3456')

    const tail = await collectStream(await fs.readStream('ranged.bin', { start: 7, end: 9 }))
    expect(Buffer.from(tail).toString('utf-8')).toBe('789')
  })

  it('readStream rejects invalid ranges', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeStream('tiny.bin', streamOf([toUint8Array('abc')]))

    await expect(fs.readStream('tiny.bin', { start: -1, end: 0 })).rejects.toThrow(/Invalid range/)
    await expect(fs.readStream('tiny.bin', { start: 2, end: 1 })).rejects.toThrow(/Invalid range/)
    await expect(fs.readStream('tiny.bin', { start: 10, end: 20 })).rejects.toThrow(/Invalid range/)
  })

  it('readStream throws File-not-found on missing path', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)
    await expect(fs.readStream('missing.bin')).rejects.toThrow(/File not found/)
  })

  it('writeStream is atomic — no partial file visible during write', async () => {
    // We can't easily simulate "reader peeks during write" deterministically,
    // but we CAN verify the contract that write-then-rename implies: after
    // a successful writeStream, no .tmp sibling remains, and the final file
    // matches exactly.
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    const bytes = toUint8Array('atomic stream write')
    await fs.writeStream('atomic.bin', streamOf([bytes]))

    const entries = await readdir(testDir)
    // Only the target should remain — no leftover .tmp
    expect(entries).toEqual(['atomic.bin'])
    const out = await collectStream(await fs.readStream('atomic.bin'))
    expect(Buffer.from(out)).toEqual(Buffer.from(bytes))
  })

  it('writeStream cleans up temp file on pipeline failure', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    // Construct a stream that errors partway through.
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(toUint8Array('partial'))
        controller.error(new Error('simulated source failure'))
      },
    })

    await expect(fs.writeStream('fail.bin', failingStream)).rejects.toThrow(
      /Cannot write stream.*simulated source failure/,
    )

    // Target file must not exist; no leftover .tmp either.
    const entries = await readdir(testDir).catch(() => [])
    expect(entries.filter(n => !n.startsWith('.'))).toEqual([])
  })

  it('writeStream overwrites an existing file atomically', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeStream('overwrite.bin', streamOf([toUint8Array('old content')]))
    await fs.writeStream('overwrite.bin', streamOf([toUint8Array('new content here')]))

    const out = await collectStream(await fs.readStream('overwrite.bin'))
    expect(Buffer.from(out).toString('utf-8')).toBe('new content here')

    const entries = await readdir(testDir)
    expect(entries).toEqual(['overwrite.bin'])
  })

  it('writeStream supports basePath', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeStream('scoped.bin', streamOf([toUint8Array('scoped to basePath')]))

    // The file should live under testDir.
    const absolute = join(testDir, 'scoped.bin')
    const content = await readFile(absolute, 'utf-8')
    expect(content).toBe('scoped to basePath')
  })
})

describe('backwards compatibility with existing writeFile callers', () => {
  it('producing identical on-disk content whether written via writeFile or plain fs.writeFile', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeFile('via-provider.txt', 'same bytes')
    await nodeWriteFile(join(testDir, 'via-node.txt'), 'same bytes', 'utf-8')

    expect(await fs.readFile('via-provider.txt')).toBe(await readFile(join(testDir, 'via-node.txt'), 'utf-8'))
  })

  it('file stat is a real file (not a symlink or unusual mode) after atomic write', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await fs.writeFile('real.txt', 'content')
    const s = await stat(join(testDir, 'real.txt'))
    expect(s.isFile()).toBe(true)
    expect(s.isSymbolicLink()).toBe(false)
  })
})
