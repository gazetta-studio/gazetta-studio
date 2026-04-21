/**
 * Suppress the spurious `--localstorage-file` warning from Node 25's
 * built-in webstorage module.
 *
 * Origin: `@vue/devtools-kit` (loaded by Pinia-powered stores even in test
 * mode) calls `localStorage.getItem()` at module init. Node 25 gates its
 * built-in webstorage implementation behind the `--localstorage-file` CLI
 * flag; when that flag is absent, reads succeed but a one-time
 * ProcessWarning is emitted. We can't pass the flag (it would persist
 * localStorage to disk between test runs) and we don't control the
 * devtools-kit code path.
 *
 * Scope: only the exact warning message is filtered. Any other
 * ProcessWarning passes through normally.
 */
const originalEmit = process.emit.bind(process)

const suppressedMessage = /localstorage-file.*was provided without a valid path/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(process as any).emit = function emit(name: string, ...args: unknown[]): boolean {
  if (name === 'warning' && args[0] instanceof Error && suppressedMessage.test(args[0].message)) {
    return false
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalEmit as any)(name, ...args)
}
