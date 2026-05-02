/**
 * Unit tests for the audio analyzer. Pure (no storage I/O) — analyzer
 * takes bytes, returns manifest enrichment with `duration` (ms) or
 * an empty result on parse failure.
 *
 * Fixtures are hand-crafted minimal WAV bytes — the format is the
 * simplest of the supported audio MIMEs (44-byte header, raw PCM
 * samples). `music-metadata` extracts duration from the header alone.
 */
import { describe, expect, it } from 'vitest'
import { audioAnalyzer } from '../src/assets/analyze-audio.js'

/**
 * Build a minimal valid WAV: 8 kHz, 8-bit, mono PCM. Header layout
 * follows the canonical RIFF spec — `music-metadata` parses duration
 * from `dataSize / (sampleRate * channels * bytesPerSample)`.
 */
function wavBytes(seconds: number, sampleRate = 8000): Uint8Array {
  const numSamples = sampleRate * seconds
  const dataSize = numSamples
  const buf = Buffer.alloc(44 + dataSize)
  // RIFF header
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  // fmt chunk
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate, 28) // byte rate (1 byte/sample × sampleRate)
  buf.writeUInt16LE(1, 32) // block align
  buf.writeUInt16LE(8, 34) // bits per sample
  // data chunk
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  // (silence — bytes 44..end stay zero, which is mid-range for 8-bit unsigned)
  return new Uint8Array(buf)
}

const INPUT = (mime: string, bytes: Uint8Array) => ({
  bytes,
  assetName: 'song',
  hash: 'abc12345',
  ext: 'wav',
  mime,
})

describe('audioAnalyzer', () => {
  it('matches every v1 audio MIME', () => {
    expect(audioAnalyzer.matches('audio/mpeg')).toBe(true)
    expect(audioAnalyzer.matches('audio/wav')).toBe(true)
    expect(audioAnalyzer.matches('audio/x-wav')).toBe(true)
    expect(audioAnalyzer.matches('audio/flac')).toBe(true)
    expect(audioAnalyzer.matches('audio/x-flac')).toBe(true)
    expect(audioAnalyzer.matches('audio/ogg')).toBe(true)
    expect(audioAnalyzer.matches('audio/opus')).toBe(true)
    expect(audioAnalyzer.matches('audio/aac')).toBe(true)
    expect(audioAnalyzer.matches('audio/mp4')).toBe(true)
    expect(audioAnalyzer.matches('audio/x-m4a')).toBe(true)
  })

  it('does not match non-audio MIMEs', () => {
    expect(audioAnalyzer.matches('image/jpeg')).toBe(false)
    expect(audioAnalyzer.matches('image/gif')).toBe(false)
    expect(audioAnalyzer.matches('application/pdf')).toBe(false)
    expect(audioAnalyzer.matches('video/mp4')).toBe(false)
    expect(audioAnalyzer.matches(null)).toBe(false)
  })

  it('extracts duration in milliseconds from a 1-second WAV', async () => {
    const bytes = wavBytes(1)
    const result = await audioAnalyzer.analyze(INPUT('audio/wav', bytes))
    expect(result.manifestPatch).toEqual({ duration: 1000 })
    expect(result.supplementaryFiles).toBeUndefined()
  })

  it('rounds fractional durations to the nearest millisecond', async () => {
    // 8000 samples at 8001 Hz = 0.99987... seconds → 1000ms (rounded)
    const buf = Buffer.alloc(44 + 8000)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + 8000, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(8001, 24)
    buf.writeUInt32LE(8001, 28)
    buf.writeUInt16LE(1, 32)
    buf.writeUInt16LE(8, 34)
    buf.write('data', 36)
    buf.writeUInt32LE(8000, 40)
    const result = await audioAnalyzer.analyze(INPUT('audio/wav', new Uint8Array(buf)))
    expect(result.manifestPatch?.duration).toBe(1000)
  })

  it('returns empty result when bytes are unparseable', async () => {
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const result = await audioAnalyzer.analyze(INPUT('audio/wav', garbage))
    expect(result).toEqual({})
  })
})
