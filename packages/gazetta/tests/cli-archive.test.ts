/**
 * Tests for the `gazetta archive` CLI dispatcher.
 *
 * Cut 13 of soft-delete-v1. Mirrors the cli-assets-cli.test.ts pattern:
 * focus on dispatch + argument parsing + error paths via injected
 * OutputSink. The list/purge/restore/rename happy paths route through
 * the admin-api routes (already covered by admin-api-archive.test.ts +
 * admin-api-rename.test.ts), so this file focuses on what's unique to
 * the CLI: usage printing, missing-argument handling, sink wiring.
 */
import { describe, expect, it, vi } from 'vitest'
import { runArchiveSubcommand } from '../src/cli/archive.js'
import { recordingSink } from '../src/cli/assets-cli.js'

describe('runArchiveSubcommand — dispatch', () => {
  it('prints usage and exits 1 when no subcommand is given', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runArchiveSubcommand({ args: [], siteDir: '/tmp', sink, exitOnError: exit })

    expect(exit).toHaveBeenCalledWith(1)
    const errors = sink.lines.filter(l => l.startsWith('error:'))
    expect(errors.some(l => l.includes('Usage'))).toBe(true)
    expect(errors.some(l => l.includes('list'))).toBe(true)
    expect(errors.some(l => l.includes('purge'))).toBe(true)
    expect(errors.some(l => l.includes('restore'))).toBe(true)
    expect(errors.some(l => l.includes('rename'))).toBe(true)
  })

  it('prints usage and exits 1 on unknown subcommand', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runArchiveSubcommand({
      args: ['unknown-command'],
      siteDir: '/tmp',
      sink,
      exitOnError: exit,
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(sink.lines.some(l => l.includes('Usage'))).toBe(true)
  })

  it('exits 1 when purge is invoked without a name', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runArchiveSubcommand({
      args: ['purge'],
      siteDir: '/tmp',
      sink,
      exitOnError: exit,
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(sink.lines.some(l => l.includes('purge <name>'))).toBe(true)
  })

  it('exits 1 when restore is invoked without a name', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runArchiveSubcommand({
      args: ['restore'],
      siteDir: '/tmp',
      sink,
      exitOnError: exit,
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(sink.lines.some(l => l.includes('restore <name>'))).toBe(true)
  })

  it('exits 1 when rename is invoked without enough args', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runArchiveSubcommand({
      args: ['rename', 'only-one'],
      siteDir: '/tmp',
      sink,
      exitOnError: exit,
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(sink.lines.some(l => l.includes('rename <oldname> <newname>'))).toBe(true)
  })

  it('rename without any args exits with usage', async () => {
    const sink = recordingSink()
    const exit = vi.fn()
    await runArchiveSubcommand({
      args: ['rename'],
      siteDir: '/tmp',
      sink,
      exitOnError: exit,
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(sink.lines.some(l => l.includes('rename <oldname> <newname>'))).toBe(true)
  })
})
