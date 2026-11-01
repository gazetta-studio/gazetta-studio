import type { CliLogin } from '../api/cliLogin.js'

/**
 * What the CLI sign-in page shows (design-agent-access.md Q19, Q21). The
 * elevation states carry the machine so their messages can name it (Q12, Q17).
 */
export type CliLoginState =
  | { kind: 'loading' }
  | { kind: 'pending'; login: CliLogin }
  | { kind: 'approved' }
  | { kind: 'denied'; elevation?: boolean }
  | { kind: 'elevation-active'; machine: string; elevationId: string; endsAt: string }
  | { kind: 'elevation-ended'; machine: string }
  | { kind: 'expired' }
  | { kind: 'not-found' }
  | { kind: 'error'; detail: string }
