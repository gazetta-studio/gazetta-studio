/**
 * ESI assembly â pure string functions, no I/O, no platform deps.
 * Used by edge workers and Node servers to compose pages from fragments.
 */

/** Parse and strip cache comment from page HTML */
export function parseCacheComment(html: string): { html: string; browser: number; edge: number } {
  const match = html.match(/^<!--cache:browser=(\d+),edge=(\d+)-->\n/)
  if (!match) return { html, browser: 0, edge: 86400 }
  return {
    html: html.slice(match[0].length),
    browser: parseInt(match[1], 10),
    edge: parseInt(match[2], 10),
  }
}

/** Split fragment HTML into head and body sections */
export function splitFragment(html: string): { head: string; body: string } {
  const headStart = html.indexOf('<head>')
  const headEnd = html.indexOf('</head>')

  if (headStart === -1 || headEnd === -1) {
    return { head: '', body: html }
  }

  return {
    head: html.slice(headStart + 6, headEnd).trim(),
    body: (html.slice(0, headStart) + html.slice(headEnd + 7)).trim(),
  }
}

/** One ESI marker found by scanEsiMarkers */
export interface EsiMarker {
  kind: 'head' | 'body'
  path: string
  /** Index of the marker's opening '<' in the scanned HTML */
  start: number
  /** Index just past the marker's closing '-->' */
  end: number
}

/**
 * Find every ESI marker in linear time.
 *
 * A marker is `<!--esi:/path-->` or `<!--esi-head:/path-->` where the path
 * starts with `/` plus at least one more character and contains no `>`. An
 * opening with no `-->` after it, or with `>` before the `-->`, is not a
 * marker. This matches what the previous regexes matched, but indexOf
 * scanning does not backtrack: page HTML with many unclosed `<!--esi:`
 * openings took quadratic time before (CodeQL js/polynomial-redos), and
 * markers are scanned on every request in the worker and in `gazetta serve`.
 */
export function scanEsiMarkers(html: string): EsiMarker[] {
  const markers: EsiMarker[] = []
  let pos = 0
  while (pos < html.length) {
    const open = html.indexOf('<!--esi', pos)
    if (open === -1) break

    let kind: 'head' | 'body'
    let pathStart: number
    if (html.startsWith('-head:', open + 7)) {
      kind = 'head'
      pathStart = open + 13
    } else if (html.startsWith(':', open + 7)) {
      kind = 'body'
      pathStart = open + 8
    } else {
      // Not an ESI opening. Advance one character, like a failed regex match.
      pos = open + 1
      continue
    }

    const close = html.indexOf('-->', pathStart)
    if (close === -1) break

    const path = html.slice(pathStart, close)
    // Equivalent of `(\/[^>]+)`: a slash plus at least one character, no `>`.
    if (path.length > 1 && path.startsWith('/') && !path.includes('>')) {
      markers.push({ kind, path, start: open, end: close + 3 })
      // A consumed marker hides any '<!--esi' inside it, like regex lastIndex.
      pos = close + 3
    } else {
      pos = open + 1
    }
  }
  return markers
}

/** Replace each marker in place, reading positions from the scanned HTML */
function replaceEsiMarkers(html: string, markers: EsiMarker[], replacement: (marker: EsiMarker) => string): string {
  if (markers.length === 0) return html
  const parts: string[] = []
  let last = 0
  for (const marker of markers) {
    parts.push(html.slice(last, marker.start), replacement(marker))
    last = marker.end
  }
  parts.push(html.slice(last))
  return parts.join('')
}

/** Find all ESI paths referenced in the page HTML */
export function findEsiPaths(html: string): string[] {
  const paths = new Set<string>()
  for (const marker of scanEsiMarkers(html)) paths.add(marker.path)
  return [...paths]
}

/** Assemble page HTML with fragment head and body content */
export function assembleEsi(pageHtml: string, fragments: Map<string, { head: string; body: string }>): string {
  const markers = scanEsiMarkers(pageHtml)

  // Collect ESI head order from page
  const esiHeadOrder: string[] = []
  for (const marker of markers) {
    if (marker.kind === 'head' && !esiHeadOrder.includes(marker.path)) esiHeadOrder.push(marker.path)
  }

  // Collect CSS and JS separately, preserving fragment order, deduplicating
  const cssLines: string[] = []
  const jsLines: string[] = []
  const otherLines: string[] = []
  const seen = new Set<string>()

  for (const path of esiHeadOrder) {
    const frag = fragments.get(path)
    if (!frag?.head) continue
    for (const line of frag.head
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)) {
      if (seen.has(line)) continue
      seen.add(line)
      if (line.includes('rel="stylesheet"') || line.includes("rel='stylesheet'")) {
        cssLines.push(line)
      } else if (line.startsWith('<script')) {
        jsLines.push(line)
      } else {
        otherLines.push(line)
      }
    }
  }

  // Replace first esi-head with other + CSS, remove the rest
  const collectedCss = [...otherLines, ...cssLines].join('\n  ')
  let cssInserted = false
  let html = replaceEsiMarkers(
    pageHtml,
    markers.filter(m => m.kind === 'head'),
    () => {
      if (!cssInserted && collectedCss) {
        cssInserted = true
        return collectedCss
      }
      return ''
    },
  )

  // Insert JS before </head> (after all CSS, preserving fragment order)
  if (jsLines.length > 0) {
    html = html.replace('</head>', `  ${jsLines.join('\n  ')}\n</head>`)
  }

  // Replace esi body tags with fragment body content. Rescan rather than reuse
  // positions: the passes above rewrote the HTML, and their replacement text
  // could itself contain markers the body pass would have matched.
  html = replaceEsiMarkers(
    html,
    scanEsiMarkers(html).filter(m => m.kind === 'body'),
    marker => {
      const frag = fragments.get(marker.path)
      return frag?.body ?? `<!-- fragment not found: ${marker.path} -->`
    },
  )

  return html
}
