/**
 * Typed representation of what the user selected in the component tree.
 *
 * Every selection is one of four kinds. The kind determines what the
 * editor panel shows and what hash goes in the URL. All path parsing
 * and construction lives here — no ad-hoc string splitting elsewhere.
 */

/** User clicked the page/fragment root node — opens root content editor. */
interface RootSelection {
  kind: 'root'
}

/** User clicked an inline component — opens its editor. */
export interface ComponentSelection {
  kind: 'component'
  /** Component path within the page/fragment, e.g. "hero" or "features/fast". */
  path: string
  /** Template name for the component. */
  template: string
}

/** User clicked a fragment reference from page context — shows "go to fragment" link. */
export interface FragmentLinkSelection {
  kind: 'fragmentLink'
  /** Fragment name, e.g. "header". */
  fragmentName: string
  /** The full tree path that was clicked, e.g. "@header" or "@header/logo". */
  treePath: string
  /** If a child was clicked, the child's path relative to the fragment, e.g. "logo". Null for the fragment root. */
  childPath: string | null
}

/** User clicked a fragment root when already on a fragment page — opens it for editing. */
export interface FragmentEditSelection {
  kind: 'fragmentEdit'
  /** Fragment name, e.g. "header". */
  fragmentName: string
}

export type EditorSelection = RootSelection | ComponentSelection | FragmentLinkSelection | FragmentEditSelection

// --- Stash key ---

/** Derive the stash map key for a selection. */
export function selectionToStashKey(sel: EditorSelection): string | null {
  switch (sel.kind) {
    case 'root':
      return '_root'
    case 'component':
      return sel.path
    case 'fragmentLink':
      return null // fragment links don't open the editor — nothing to stash
    case 'fragmentEdit':
      return `@${sel.fragmentName}`
  }
}

/** Derive the error label for a failed navigation. */
export function selectionToErrorLabel(sel: EditorSelection): string {
  switch (sel.kind) {
    case 'root':
      return 'page root'
    case 'component':
      return sel.template || sel.path
    case 'fragmentLink':
      return sel.fragmentName
    case 'fragmentEdit':
      return `fragment "${sel.fragmentName}"`
  }
}

// --- URL hash serialization ---

/**
 * Encode a selection as a URL hash string.
 * No prefix — the hash is scoped to the edit route, so #hero is unambiguous.
 */
export function selectionToHash(sel: EditorSelection): string {
  switch (sel.kind) {
    case 'root':
      return '' // no hash = root selected
    case 'component':
      return `#${sel.path}`
    case 'fragmentLink':
      return `#${sel.treePath}`
    case 'fragmentEdit':
      return `#@${sel.fragmentName}`
  }
}

/**
 * Parse a URL hash into an EditorSelection. Returns null if the hash
 * is empty.
 *
 * Context-dependent: the same hash `@header` means "fragment link" on
 * a page and "fragment edit" on a fragment page. The `onFragmentPage`
 * flag disambiguates.
 */
export function hashToSelection(hash: string, onFragmentPage: boolean): EditorSelection | null {
  if (!hash || hash === '#') return { kind: 'root' } // no hash = root selected
  const value = hash.slice(1)
  if (!value) return { kind: 'root' }

  if (value.startsWith('@')) {
    const parts = value.slice(1).split('/')
    const fragmentName = parts[0]
    const childPath = parts.length > 1 ? parts.slice(1).join('/') : null

    if (onFragmentPage) {
      return { kind: 'fragmentEdit', fragmentName }
    }
    return { kind: 'fragmentLink', fragmentName, treePath: value, childPath }
  }

  return { kind: 'component', path: value, template: '' }
}

/**
 * When navigating from a fragment link to the fragment's edit page,
 * compute the hash for the destination. If the user clicked a child
 * (e.g. @header/logo), the destination hash is #logo.
 */
export function fragmentLinkDestinationHash(sel: FragmentLinkSelection): string {
  if (sel.childPath) {
    return `#${sel.childPath}`
  }
  return ''
}
