/**
 * The prompt must reach `claude` via STDIN, not as an argv entry.
 *
 * Passing it as an argument put the whole prompt — reviewer template +
 * issue body + the full `git diff` of Agent A's work — into the exec
 * argument vector, which the OS caps at ARG_MAX. A cut with a large
 * diff therefore died with `spawn E2BIG` *after* Agent A had already
 * committed its work.
 *
 * Observed 2026-10-03, feature-bot run 37150215338 on cut #524: Agent A
 * committed the story-render gate, the orchestrator then invoked Agent B
 * and the run logged `#524 threw: Error: spawn E2BIG`. The generator
 * half of the generator-critic loop worked; the critic half was
 * unreachable for any cut whose diff was big enough. This very likely
 * also accounts for the earlier "exited 1" / "exited 143" failures on
 * the two largest cuts (#519, #526).
 *
 * Two layers of pinning:
 *
 *  1. MECHANISM (the first two tests) — spawn a real stand-in binary
 *     (`cat`) with an over-ARG_MAX payload, argv vs stdin, and assert
 *     that argv throws E2BIG while stdin succeeds. This pins the actual
 *     OS behavior the fix depends on, deterministically and without
 *     invoking the real `claude` binary (which would be slow, costly
 *     and non-deterministic).
 *
 *  2. WIRING (the last test) — assert `claude.ts` actually uses the
 *     stdin path. Nothing in the type system can express "the prompt is
 *     not in the argv array", and driving the real binary in a unit test
 *     is out of scope, so this is a deliberate structural assertion (the
 *     same rationale the rate-limit cascade test documents).
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLAUDE_LIB = resolve(HERE, '..', 'claude.ts')

/** Comfortably over ARG_MAX on every platform we run on (Linux ~2 MB cap, macOS 1 MB). */
const HUGE = 'x'.repeat(4 * 1024 * 1024)

/**
 * Note: Node throws E2BIG SYNCHRONOUSLY from `spawn()` for an
 * over-ARG_MAX argv — it does not surface as an async 'error' event —
 * so this has to be a try/catch rather than a promise handler.
 */
function spawnWithArgv(payload: string): { err: NodeJS.ErrnoException | null } {
  try {
    const child = spawn('cat', [payload], { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('error', () => {})
    child.kill()
    return { err: null }
  } catch (e) {
    return { err: e as NodeJS.ErrnoException }
  }
}

function spawnWithStdin(payload: string): Promise<{ err: NodeJS.ErrnoException | null; bytes: number }> {
  return new Promise(res => {
    const child = spawn('cat', [], { stdio: ['pipe', 'pipe', 'ignore'] })
    let bytes = 0
    child.stdout.on('data', (c: Buffer) => {
      bytes += c.length
    })
    child.on('error', err => res({ err: err as NodeJS.ErrnoException, bytes }))
    child.on('close', () => res({ err: null, bytes }))
    child.stdin.on('error', () => {})
    child.stdin.end(payload)
  })
}

describe('prompt delivery mechanism', () => {
  it('an over-ARG_MAX payload in ARGV fails with E2BIG (the bug)', () => {
    const { err } = spawnWithArgv(HUGE)
    expect(err, 'a 4 MB argv entry must be rejected by the OS').not.toBeNull()
    expect(err?.code).toBe('E2BIG')
  })

  it('the same payload over STDIN succeeds (the fix)', async () => {
    const { err, bytes } = await spawnWithStdin(HUGE)
    expect(err).toBeNull()
    // `cat` echoes stdin back, so a full round-trip proves the pipe
    // carried the whole payload — no silent truncation.
    expect(bytes).toBe(HUGE.length)
  })
})

describe('runClaude wiring', () => {
  const source = readFileSync(CLAUDE_LIB, 'utf-8')

  it('writes the prompt to child stdin', () => {
    expect(source).toMatch(/child\.stdin\.end\(\s*opts\.prompt\s*\)/)
  })

  it('opens stdin as a pipe rather than ignoring it', () => {
    // `stdio: ['ignore', ...]` was what forced the prompt into argv.
    expect(source).toMatch(/stdio:\s*\['pipe',\s*'pipe',\s*'inherit'\]/)
  })

  it('does NOT pass opts.prompt inside the spawn argument array', () => {
    // The argv array ends with the permissions flag; the prompt must not
    // reappear there. Match the array literal and assert the absence.
    const argv = source.match(/spawn\(\s*'claude',\s*\[([\s\S]*?)\]/)
    expect(argv, 'spawn argv array must be present').toBeTruthy()
    expect(argv?.[1]).not.toMatch(/opts\.prompt/)
  })
})
