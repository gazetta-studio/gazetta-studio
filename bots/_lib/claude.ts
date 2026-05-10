/**
 * Claude Code CLI wrapper for bots.
 *
 * Bots delegate the "intelligent" part of their work to a headless `claude -p`
 * invocation. The orchestration (data plumbing, dedup, action) stays in TS;
 * the prompt-driven analysis and tool-call sequence belongs to Claude.
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN env var. The Claude Code CLI reads it
 * automatically — no flag needed. Bills against the Claude account's
 * subscription rather than per-token API spend.
 */
import { spawnSync } from 'node:child_process'

export interface ClaudeOptions {
  /** The prompt content (system + user combined). */
  prompt: string
  /**
   * Tools Claude is allowed to invoke. Default `['Bash']` — most bots only
   * need to shell out to gh CLI. Pass `['Bash', 'Read']` if Claude also
   * needs to read repo files, etc.
   */
  allowedTools?: string[]
  /**
   * Working directory for tool calls. Default `process.cwd()`.
   */
  cwd?: string
}

export interface ClaudeResult {
  /** Exit code from the claude binary. 0 = success. */
  exitCode: number
  /** True when claude exited 0. */
  success: boolean
}

/**
 * Run `claude -p` headless. Streams stdout/stderr to the parent process so
 * the bot's logs show Claude's tool-call output inline.
 *
 * Flag rationale:
 *   --print               : non-interactive, exit after response
 *   --allowedTools <list> : restrict to the tools the prompt actually needs
 *   --dangerously-skip-permissions : no human in CI to approve tool calls;
 *                           --allowedTools is the safety boundary
 *
 * Do NOT pass --bare — it disables OAuth token reading per the CLI docs.
 */
export function runClaude(opts: ClaudeOptions): ClaudeResult {
  const tools = opts.allowedTools ?? ['Bash']
  const result = spawnSync(
    'claude',
    ['--print', '--allowedTools', tools.join(','), '--dangerously-skip-permissions', opts.prompt],
    {
      stdio: 'inherit',
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
    },
  )
  return { exitCode: result.status ?? 1, success: result.status === 0 }
}
