/**
 * Builds the shared modules the admin's import map points custom editors and
 * fields to (`/admin/_shared/*.js`).
 *
 * All modules are built in one esbuild call with code splitting, so they share
 * one copy of React: a hook called through `_shared/react.js` must run in the
 * same React that `_shared/react-dom_client.js` renders with.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'

const SHARED_SPECIFIERS = ['react', 'react-dom/client', 'react/jsx-runtime', 'gazetta/editor', 'gazetta/types']

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * The stub module that re-exports `specifier`. esbuild can't list a CommonJS
 * module's exports for `export *` (React is CommonJS), so those get their
 * named exports spelled out, read from the module itself.
 */
function stubFor(specifier: string, requireFromShared: NodeJS.Require): string {
  let mod: unknown
  try {
    mod = requireFromShared(specifier)
  } catch {
    mod = undefined
  }
  const isCommonJs =
    mod !== null &&
    (typeof mod === 'object' || typeof mod === 'function') &&
    (mod as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] !== 'Module'
  if (!isCommonJs) return `export * from ${JSON.stringify(specifier)};`
  const names = Object.keys(mod as object).filter(n => IDENTIFIER.test(n) && n !== 'default' && n !== '__esModule')
  const lines = [`import M from ${JSON.stringify(specifier)};`, 'export default M;']
  if (names.length > 0) lines.push(`export const { ${names.join(', ')} } = M;`)
  return lines.join('\n')
}

/** Returns the import map: specifier → URL, for the modules that could be built. */
export async function buildSharedDeps(sharedDir: string): Promise<Record<string, string>> {
  const { build } = await import('esbuild')
  // Chunk names carry a content hash, so chunks from an earlier build would
  // otherwise stay behind next to the new ones.
  await rm(sharedDir, { recursive: true, force: true })
  await mkdir(sharedDir, { recursive: true })
  const requireFromShared = createRequire(join(sharedDir, 'index.js'))

  // Skip specifiers that don't resolve from the project (a dependency not installed).
  const resolvable = new Set<string>()
  await build({
    stdin: { contents: '' },
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'probe-shared',
        setup(b) {
          b.onStart(async () => {
            for (const s of SHARED_SPECIFIERS) {
              const r = await b.resolve(s, { kind: 'import-statement', resolveDir: sharedDir })
              if (r.errors.length === 0 && r.path) resolvable.add(s)
            }
          })
        },
      },
    ],
  })

  const specifiers = SHARED_SPECIFIERS.filter(s => resolvable.has(s))
  const entryPoints: Record<string, string> = {}
  const stubFiles: string[] = []
  for (const specifier of specifiers) {
    const safeName = specifier.replace(/\//g, '_')
    const stubFile = join(sharedDir, `_stub_${safeName}.js`)
    await writeFile(stubFile, stubFor(specifier, requireFromShared))
    stubFiles.push(stubFile)
    entryPoints[safeName] = stubFile
  }

  const importMap: Record<string, string> = {}
  try {
    if (specifiers.length > 0) {
      await build({
        entryPoints,
        outdir: sharedDir,
        entryNames: '[name]',
        chunkNames: 'chunk-[hash]',
        bundle: true,
        splitting: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'warning',
      })
      for (const specifier of specifiers) {
        importMap[specifier] = `/admin/_shared/${specifier.replace(/\//g, '_')}.js`
      }
    }
  } finally {
    await Promise.all(stubFiles.map(f => rm(f, { force: true })))
  }
  return importMap
}
