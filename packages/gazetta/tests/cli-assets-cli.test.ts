/**
 * Tests for the `gazetta assets` CLI dispatcher and runners.
 *
 * Uses an injected `OutputSink` (`recordingSink`) instead of mocking
 * `console.log`. The runner is decoupled from transport — these tests
 * exercise the orchestration + dispatch logic without touching stdout.
 *
 * The `bootstrap`-driven loadSourceContext is harder to mock cleanly,
 * so the `info` and `list` happy-path behaviors are covered by the
 * route-level admin-api tests + the unit tests in
 * `cli-assets-display.test.ts`. This file focuses on the dispatcher
 * — argument parsing, error paths, sink wiring.
 */
import { describe, expect, it, vi } from 'vitest'
import { runAssetsSubcommand, recordingSink } from '../src/cli/assets-cli.js'

describe('runAssetsSubcommand — dispatch', () => {
  it('prints usage and exits 1 when no subcommand is given', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runAssetsSubcommand({ args: [], siteDir: '/tmp', sink, exitOnError: exit })

    expect(exit).toHaveBeenCalledWith(1)
    const errors = sink.lines.filter(l => l.startsWith('error:'))
    expect(errors.some(l => l.includes('Usage'))).toBe(true)
    expect(errors.some(l => l.includes('list'))).toBe(true)
    expect(errors.some(l => l.includes('info'))).toBe(true)
    expect(errors.some(l => l.includes('reindex'))).toBe(true)
  })

  it('prints usage and exits 1 on unknown subcommand', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runAssetsSubcommand({
      args: ['unknown-command'],
      siteDir: '/tmp',
      sink,
      exitOnError: exit,
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(sink.lines.some(l => l.includes('Usage'))).toBe(true)
  })

  it('exits 1 when info is invoked without an asset name', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runAssetsSubcommand({
      args: ['info'],
      siteDir: '/tmp',
      sink,
      exitOnError: exit,
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(sink.lines.some(l => l.includes('info <name>'))).toBe(true)
  })
})

describe('recordingSink', () => {
  it('captures lines with their kind prefix', () => {
    const sink = recordingSink()
    sink.heading('the heading')
    sink.line('plain line')
    sink.dim('muted')
    sink.error('something failed')
    sink.blank()

    expect(sink.lines).toEqual([
      'heading: the heading',
      'line: plain line',
      'dim: muted',
      'error: something failed',
      '',
    ])
  })
})
