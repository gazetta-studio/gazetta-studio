import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteStream, atomicWriteString } from '../src/providers/_atomic-write.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('atomic-test-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

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

describe('atomicWriteString', () => {
  it('writes content atomically (no temp file visible after success)', async () => {
    await mkdir(testDir, { recursive: true })
    const target = join(testDir, 'out.txt')

    await atomicWriteString(target, 'hello')

    expect(await readFile(target, 'utf-8')).toBe('hello')
    // write-file-atomic places its temp alongside and renames on success — verify no leftovers
    expect(await readdir(testDir)).toEqual(['out.txt'])
  })

  it('overwrites an existing file atomically', async () => {
    await mkdir(testDir, { recursive: true })
    const target = join(testDir, 'overwrite.txt')

    await atomicWriteString(target, 'v1')
    await atomicWriteString(target, 'v2')

    expect(await readFile(target, 'utf-8')).toBe('v2')
    expect(await readdir(testDir)).toEqual(['overwrite.txt'])
  })
})

describe('atomicWriteStream', () => {
  it('writes a stream atomically and creates intermediate directories', async () => {
    await mkdir(testDir, { recursive: true })
    const target = join(testDir, 'deep/nested/out.bin')

    await atomicWriteStream(target, streamOf([toUint8Array('streamed')]))

    expect((await readFile(target)).toString('utf-8')).toBe('streamed')
  })

  it('cleans up the temp file when the source stream errors', async () => {
    await mkdir(testDir, { recursive: true })
    const target = join(testDir, 'fail.bin')

    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(toUint8Array('partial'))
        controller.error(new Error('simulated source failure'))
      },
    })

    await expect(atomicWriteStream(target, failingStream)).rejects.toThrow(/simulated source failure/)

    // Target must not exist; no leftover .tmp sibling either.
    const entries = await readdir(testDir).catch(() => [])
    expect(entries).toEqual([])
  })

  it('overwrites an existing file atomically from a stream', async () => {
    await mkdir(testDir, { recursive: true })
    const target = join(testDir, 'over.bin')

    await atomicWriteStream(target, streamOf([toUint8Array('old')]))
    await atomicWriteStream(target, streamOf([toUint8Array('new-longer-content')]))

    expect((await readFile(target)).toString('utf-8')).toBe('new-longer-content')
    expect(await readdir(testDir)).toEqual(['over.bin'])
  })

  it('handles multi-chunk input', async () => {
    await mkdir(testDir, { recursive: true })
    const target = join(testDir, 'multi.bin')

    const chunks = ['part1-', 'part2-', 'part3'].map(toUint8Array)
    await atomicWriteStream(target, streamOf(chunks))

    expect((await readFile(target)).toString('utf-8')).toBe('part1-part2-part3')
  })
})
