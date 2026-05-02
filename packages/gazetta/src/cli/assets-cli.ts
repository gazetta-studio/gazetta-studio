/**
 * `gazetta assets <subcommand>` runner — owns I/O + dispatch to
 * subcommand handlers. Display logic lives in `assets-display.ts`
 * (pure projections + formatters).
 *
 * SOLID lenses:
 *   - SRP: one module per concern.
 *     * Subcommand dispatch lives here.
 *     * Per-subcommand orchestration (load summaries → project → emit)
 *       is one function each.
 *     * Display projection is `assets-display.ts`.
 *     * Output is via the injected sink — `console`-coupled by default,
 *       capturable in tests.
 *   - OCP: adding a subcommand = new handler + entry in the dispatch
 *     map. The dispatcher itself doesn't change shape.
 *   - DIP: runner depends on `OutputSink` interface, not on
 *     `console.log`. Tests inject a recording sink.
 */
import type { ContentRoot } from '../content-root.js'
import type { StorageProvider } from '../types.js'
import { type InfoOutput, LIST_COLUMNS, projectInfo, projectListRow, renderListTable } from './assets-display.js'

/**
 * Output sink — anything that accepts text lines. The default
 * (`consoleSink`) writes to `process.stdout` / `process.stderr`;
 * tests use `recordingSink()` to capture lines for assertion.
 *
 * Color is part of the sink's responsibility, not the runner's —
 * the runner emits semantic markers (heading, dim, error) and the
 * sink decides whether to apply ANSI codes.
 */
export interface OutputSink {
  /** Plain output line. */
  line(text: string): void
  /** Heading line (typically emphasized). */
  heading(text: string): void
  /** Dim / muted text. */
  dim(text: string): void
  /** Error line (goes to stderr in console sinks). */
  error(text: string): void
  /** Blank line separator. */
  blank(): void
}

export interface AssetsSubcommandInput {
  /** All argv after the `assets` keyword. e.g. `['list']`, `['info', 'hero']`. */
  args: readonly string[]
  /** Project site directory (passed by the top-level CLI dispatcher). */
  siteDir: string
  /** Optional target name override (positional / auto-detected). */
  targetName?: string
  /** Sink for output. Defaults to `consoleSink` when omitted. */
  sink?: OutputSink
  /** Test hook: skip `process.exit` on bad input. */
  exitOnError?: (code: number) => void
}

const SUBCOMMANDS = ['list', 'info', 'reindex'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

/**
 * Top-level dispatch for `gazetta assets <subcommand>`. Resolves the
 * subcommand, routes to its handler, and invokes the exit hook on
 * usage errors. The dispatcher itself doesn't know what each handler
 * does — adding a new subcommand means appending to `SUBCOMMANDS`
 * and the switch.
 */
export async function runAssetsSubcommand(input: AssetsSubcommandInput): Promise<void> {
  const sink = input.sink ?? consoleSink
  const exit = input.exitOnError ?? ((code: number) => process.exit(code))

  const subcommand = input.args[0]
  if (!subcommand || !isSubcommand(subcommand)) {
    printUsage(sink)
    exit(1)
    return
  }

  switch (subcommand) {
    case 'list':
      await runList({ siteDir: input.siteDir, targetName: input.targetName, sink })
      return
    case 'info': {
      const assetName = input.args[1]
      if (!assetName) {
        sink.error('Usage: gazetta assets info <name> [target] [site]')
        exit(1)
        return
      }
      await runInfo({ siteDir: input.siteDir, targetName: input.targetName, assetName, sink, exit })
      return
    }
    case 'reindex':
      await runReindex({ siteDir: input.siteDir, targetName: input.targetName, sink })
      return
  }
}

function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s)
}

function printUsage(sink: OutputSink): void {
  sink.error('Usage: gazetta assets <list|info|reindex>')
  sink.error('  list <target>             — list assets on a target')
  sink.error('  info <name> [target]      — show detail for one asset')
  sink.error('  reindex [target]          — rebuild the asset-refs sidecar index')
}

// ---------- subcommand handlers ----------

interface RunnerCommonContext {
  source: { storage: StorageProvider; contentRoot: ContentRoot }
}

async function loadSourceContext(siteDir: string, targetName?: string): Promise<RunnerCommonContext['source']> {
  const { buildSourceContext } = await import('./bootstrap.js')
  const { source } = await buildSourceContext({ projectSiteDir: siteDir, targetName })
  return source
}

async function runList(opts: { siteDir: string; targetName?: string; sink: OutputSink }): Promise<void> {
  const { sink } = opts
  sink.blank()
  sink.heading('gazetta assets list')
  sink.blank()

  const source = await loadSourceContext(opts.siteDir, opts.targetName)
  const { listAssets } = await import('../assets/list.js')
  const summaries = await listAssets({ storage: source.storage, assetsRoot: 'assets' })

  if (summaries.length === 0) {
    sink.dim('No assets on this target.')
    sink.blank()
    return
  }

  const rows = summaries.map(projectListRow)
  const lines = renderListTable(rows)
  // First line is the header — emit dim.
  if (lines.length > 0) {
    sink.dim(lines[0]!)
    for (const line of lines.slice(1)) sink.line(line)
  }
  sink.blank()
  sink.dim(`${rows.length} asset(s).`)
  sink.blank()
}

async function runInfo(opts: {
  siteDir: string
  targetName?: string
  assetName: string
  sink: OutputSink
  exit: (code: number) => void
}): Promise<void> {
  const { sink, assetName } = opts
  sink.blank()
  sink.heading(`gazetta assets info ${assetName}`)
  sink.blank()

  const source = await loadSourceContext(opts.siteDir, opts.targetName)
  const { readManifest } = await import('../assets/manifest.js')
  const { enumerateOverrideSlices } = await import('../assets/asset-paths.js')
  const { readRefsForAsset } = await import('../assets/asset-deps.js')

  let manifest
  try {
    manifest = await readManifest(source.storage, 'assets', assetName)
  } catch (err) {
    if ((err as { code?: string }).code === 'ASSET_MANIFEST_NOT_FOUND') {
      sink.error(`Asset not found: ${assetName}`)
      opts.exit(1)
      return
    }
    throw err
  }

  const [overrideSlices, references] = await Promise.all([
    enumerateOverrideSlices(source.storage, 'assets', manifest),
    readRefsForAsset(source.contentRoot, assetName),
  ])

  const info = projectInfo({ manifest, overrideSlices, references })
  emitInfo(info, sink)
}

async function runReindex(opts: { siteDir: string; targetName?: string; sink: OutputSink }): Promise<void> {
  const { sink } = opts
  sink.blank()
  sink.heading('gazetta assets reindex')
  sink.blank()
  sink.dim('Note: stop any running dev server before reindexing to avoid drift.')
  sink.blank()

  const { buildSourceContext } = await import('./bootstrap.js')
  const { source, manifest } = await buildSourceContext({
    projectSiteDir: opts.siteDir,
    targetName: opts.targetName,
  })

  const { loadSite } = await import('../site-loader.js')
  const { rebuildDepIndex } = await import('../publish-rendered.js')
  const { ASSET_REFS } = await import('../assets/asset-deps.js')
  const { FRAGMENT_DEPS } = await import('../fragment-deps.js')

  const site = await loadSite({ contentRoot: source.contentRoot, manifest })
  const t0 = Date.now()
  await Promise.all([
    rebuildDepIndex(ASSET_REFS, site, source.contentRoot.storage, source.contentRoot.rootPath),
    rebuildDepIndex(FRAGMENT_DEPS, site, source.contentRoot.storage, source.contentRoot.rootPath),
  ])
  const elapsed = Date.now() - t0

  sink.line(`✓ Rebuilt dep indices for ${site.pages.size} page(s) + ${site.fragments.size} fragment(s) in ${elapsed}ms`)
}

/**
 * Emit a structured InfoOutput through the sink. The sink decides
 * styling (color, prefixes); this function decides ordering and
 * which sections appear when empty.
 */
function emitInfo(info: InfoOutput, sink: OutputSink): void {
  // Metadata section — always emitted, fixed key-value pairs.
  const labelWidth = Math.max(...info.metadata.rows.map(r => r.label.length))
  for (const row of info.metadata.rows) {
    sink.line(`${dimLabel(row.label, labelWidth)}  ${row.value}`)
  }

  // Variant ladder — only when present.
  if (info.variants.length > 0) {
    sink.blank()
    sink.heading('Variants')
    for (const v of info.variants) {
      sink.line(`  ${v.width.padStart(5)}  ${v.size.padStart(8)}  ${v.path}`)
    }
  }

  // Override slices — only when present.
  if (info.overrides.length > 0) {
    sink.blank()
    sink.heading('Locale / theme overrides')
    for (const slice of info.overrides) {
      sink.line(`  ${slice.selector.padEnd(20)}  ${slice.bytes}`)
    }
  }

  // References — always emitted; "none" when empty.
  sink.blank()
  if (info.references.length === 0) {
    sink.heading(`References  ${'(none)'}`)
  } else {
    sink.heading(`References (${info.references.length})`)
    for (const ref of info.references) {
      sink.line(`  ${ref.path}`)
    }
  }
  sink.blank()
}

/** Pad a label to fixed width with a dim hint marker for the sink. */
function dimLabel(label: string, width: number): string {
  return `\x00DIM\x00${label.padEnd(width)}\x00END\x00`
}

// ---------- sinks ----------

/**
 * Default sink: writes to `process.stdout` / `process.stderr` with
 * ANSI codes (suppressed via `NO_COLOR` env var or non-TTY stdout).
 *
 * Recognises the special `\x00DIM\x00…\x00END\x00` markers emitted by
 * `dimLabel` for inline dim text in lines that are otherwise plain.
 * This keeps the projection layer free of color decisions.
 */
export const consoleSink: OutputSink = (() => {
  const noColor = !!process.env.NO_COLOR || !process.stdout.isTTY
  const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[22m`)
  const bold = (s: string) => (noColor ? s : `\x1b[1m${s}\x1b[22m`)
  const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[39m`)
  const bgGreen = (s: string) => (noColor ? s : `\x1b[42m\x1b[30m${s}\x1b[39m\x1b[49m`)
  const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[39m`)
  const inlineDim = (s: string) => s.replace(/\x00DIM\x00([\s\S]*?)\x00END\x00/g, (_m, inner) => dim(inner))
  return {
    line(text) {
      console.log(`  ${inlineDim(text)}`)
    },
    heading(text) {
      // Mirror the existing `gazetta assets reindex` heading style.
      const [name, ...rest] = text.split(' ')
      if (name === 'gazetta') {
        const subcmd = rest.join(' ')
        console.log(`  ${bgGreen(bold(' gazetta '))} ${green(subcmd)}`)
      } else {
        console.log(`  ${bold(text)}`)
      }
    },
    dim(text) {
      console.log(`  ${dim(text)}`)
    },
    error(text) {
      console.error(`  ${red('✗')} ${text}`)
    },
    blank() {
      console.log()
    },
  }
})()

/**
 * Test sink: captures lines into an array for assertion. Strips
 * the inline-dim markers so tests assert on plain text.
 */
export function recordingSink(): OutputSink & { lines: string[] } {
  const lines: string[] = []
  const strip = (s: string) => s.replace(/\x00DIM\x00([\s\S]*?)\x00END\x00/g, '$1')
  return {
    lines,
    line: text => lines.push(`line: ${strip(text)}`),
    heading: text => lines.push(`heading: ${text}`),
    dim: text => lines.push(`dim: ${strip(text)}`),
    error: text => lines.push(`error: ${strip(text)}`),
    blank: () => lines.push(''),
  }
}
