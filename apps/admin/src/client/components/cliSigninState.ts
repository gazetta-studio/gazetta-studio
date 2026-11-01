import type { CliSetup } from '../api/cliSignin.js'

/** What the "Sign in a command line" page shows. */
export type CliSigninState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; setup: CliSetup; adminUrl: string; created?: { grantSecret: string; machine: string } }
