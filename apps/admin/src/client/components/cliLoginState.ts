import type { CliLogin } from '../api/cliLogin.js'

/** What the CLI sign-in page shows (design-agent-access.md Q19, Q21). */
export type CliLoginState =
  | { kind: 'loading' }
  | { kind: 'pending'; login: CliLogin }
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'not-found' }
  | { kind: 'error'; detail: string }
