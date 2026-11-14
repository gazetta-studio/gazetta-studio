import { describe, it, expect } from 'vitest'
import type { ResolvedComponent, RenderOutput } from '../src/types.js'
import { renderComponent, renderFragment, renderPage } from '../src/renderer.js'
import { hashPath } from '../src/scope.js'
import { html } from '../src/html.js'

function leaf(html: string, css = '', js = '', treePath = ''): ResolvedComponent {
  return {
    template: () => ({ html, css, js }),
    children: [],
    treePath,
  }
}

function composite(
  render: (children: RenderOutput[]) => RenderOutput,
  children: ResolvedComponent[],
  treePath = '',
): ResolvedComponent {
  return {
    template: ({ children: c }) => render(c ?? []),
    children,
    treePath,
  }
}

describe('renderComponent', () => {
  it('renders a leaf component with scoping', async () => {
    const result = await renderComponent(leaf('<p>hello</p>', 'p { color: red; }', '', 'hero'))
    const id = hashPath('hero')
    expect(result.html).toContain(`data-gz="${id}"`)
    expect(result.html).toContain('<p>hello</p>')
    expect(result.css).toContain(`[data-gz="${id}"] p`)
  })

  it('renders a leaf with js (js is not scoped)', async () => {
    const result = await renderComponent(leaf('<div></div>', '', 'console.log("hi")', 'demo'))
    expect(result.js).toBe('console.log("hi")')
  })

  it('passes content to template', async () => {
    const component: ResolvedComponent = {
      template: ({ content }) => ({
        html: `<h1>${content?.title}</h1>`,
        css: '',
        js: '',
      }),
      content: { title: 'Hello World' },
      children: [],
      treePath: 'hero',
    }
    const result = await renderComponent(component)
    expect(result.html).toContain('<h1>Hello World</h1>')
  })

  it('renders a composite with children', async () => {
    const parent = composite(
      children => ({
        html: `<div>${children.map(c => c.html).join('')}</div>`,
        css: `.parent {} ${children.map(c => c.css).join(' ')}`,
        js: '',
      }),
      [leaf('<span>A</span>', '.a {}', '', 'features/a'), leaf('<span>B</span>', '.b {}', '', 'features/b')],
      'features',
    )
    const result = await renderComponent(parent)
    expect(result.html).toContain('<span>A</span>')
    expect(result.html).toContain('<span>B</span>')
    expect(result.css).toContain('[data-gz=')
  })

  it('each component gets a unique scope id based on tree path', async () => {
    const parent = composite(
      children => ({
        html: children.map(c => c.html).join(''),
        css: children.map(c => c.css).join('\n'),
        js: '',
      }),
      [leaf('<span>A</span>', '.a {}', '', 'section/a'), leaf('<span>B</span>', '.b {}', '', 'section/b')],
      'section',
    )
    const result = await renderComponent(parent)
    const idA = hashPath('section/a')
    const idB = hashPath('section/b')
    const idParent = hashPath('section')
    expect(result.html).toContain(`data-gz="${idA}"`)
    expect(result.html).toContain(`data-gz="${idB}"`)
    expect(result.html).toContain(`data-gz="${idParent}"`)
    // All different
    expect(new Set([idA, idB, idParent]).size).toBe(3)
  })

  it('passes route params to templates', async () => {
    const component: ResolvedComponent = {
      template: ({ params }) => ({
        html: `<h1>${params?.slug ?? 'no slug'}</h1>`,
        css: '',
        js: '',
      }),
      children: [],
      treePath: 'article',
    }
    const result = await renderComponent(component, { slug: 'hello-world' })
    expect(result.html).toContain('hello-world')
  })

  it('passes route params through to children', async () => {
    const child: ResolvedComponent = {
      template: ({ params }) => ({
        html: `<span>${params?.id ?? 'no id'}</span>`,
        css: '',
        js: '',
      }),
      children: [],
      treePath: 'parent/child',
    }
    const parent = composite(
      children => ({ html: children.map(c => c.html).join(''), css: '', js: '' }),
      [child],
      'parent',
    )
    const result = await renderComponent(parent, { id: '42' })
    expect(result.html).toContain('42')
  })

  it('renders nested composites (3 levels deep)', async () => {
    const grandchild = leaf('<em>deep</em>', '', '', 'root/mid/deep')
    const child = composite(
      children => ({
        html: `<section>${children.map(c => c.html).join('')}</section>`,
        css: '',
        js: '',
      }),
      [grandchild],
      'root/mid',
    )
    const root = composite(
      children => ({
        html: `<main>${children.map(c => c.html).join('')}</main>`,
        css: '',
        js: '',
      }),
      [child],
      'root',
    )
    const result = await renderComponent(root)
    expect(result.html).toContain('<em>deep</em>')
    expect(result.html).toContain('<section>')
    expect(result.html).toContain('<main>')
  })

  it('supports async templates', async () => {
    const component: ResolvedComponent = {
      template: async ({ content }) => ({
        html: `<h1>${content?.title}</h1>`,
        css: '',
        js: '',
      }),
      content: { title: 'Async Template' },
      children: [],
      treePath: 'async',
    }
    const result = await renderComponent(component)
    expect(result.html).toContain('<h1>Async Template</h1>')
  })

  it('collects head from template output', async () => {
    const component: ResolvedComponent = {
      template: () => ({
        html: '<div>content</div>',
        css: '',
        js: '',
        head: '<link rel="icon" href="/favicon.svg">',
      }),
      children: [],
      treePath: 'with-head',
    }
    const result = await renderComponent(component)
    expect(result.head).toContain('<link rel="icon" href="/favicon.svg">')
  })

  it('collects head from children and parent', async () => {
    const child: ResolvedComponent = {
      template: () => ({
        html: '<p>child</p>',
        css: '',
        js: '',
        head: '<link rel="preconnect" href="https://fonts.example.com">',
      }),
      children: [],
      treePath: 'layout/child',
    }
    const parent = composite(
      children => ({
        html: children.map(c => c.html).join(''),
        css: '',
        js: '',
        head: `<link rel="icon" href="/favicon.svg">\n${children
          .map(c => c.head)
          .filter(Boolean)
          .join('\n')}`,
      }),
      [child],
      'layout',
    )
    const result = await renderComponent(parent)
    expect(result.head).toContain('favicon.svg')
    expect(result.head).toContain('fonts.example.com')
  })
})

describe('renderFragment', () => {
  it('wraps output in HTML document', async () => {
    const fragment = leaf('<nav>links</nav>', 'nav {}', '', '')
    const html = await renderFragment(fragment)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<style>')
    expect(html).toContain('<nav>links</nav>')
  })

  it('includes children', async () => {
    const fragment = composite(
      children => ({ html: `<header>${children.map(c => c.html).join('')}</header>`, css: '', js: '' }),
      [leaf('<span>Logo</span>', '', '', 'logo')],
      '',
    )
    const html = await renderFragment(fragment)
    expect(html).toContain('<span>Logo</span>')
    expect(html).toContain('<header>')
  })

  it('includes head, css, and js', async () => {
    const fragment: ResolvedComponent = {
      template: () => ({
        html: '<nav>nav</nav>',
        css: 'nav { color: red; }',
        js: 'console.log("nav")',
        head: '<link rel="icon" href="/favicon.svg">',
      }),
      children: [],
      treePath: '',
    }
    const html = await renderFragment(fragment)
    expect(html).toContain('nav { color: red; }')
    expect(html).toContain('<script type="module">console.log("nav")</script>')
    expect(html).toContain('<link rel="icon" href="/favicon.svg">')
  })
})

describe('renderPage', () => {
  it('wraps output in HTML document', async () => {
    const page = leaf('<p>content</p>', 'p {}', '', 'page')
    const html = await renderPage(page)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<style>')
    expect(html).toContain('<p>content</p>')
  })

  it('renders title from template head output', async () => {
    const page: ResolvedComponent = {
      template: () => ({ html: '<p></p>', css: '', js: '', head: '<title>My Page</title>' }),
      children: [],
      treePath: '',
    }
    const html = await renderPage(page)
    expect(html).toContain('<title>My Page</title>')
  })

  it('does not inject title when template has no head', async () => {
    const page = leaf('<p>no head</p>', '', '', 'page')
    const html = await renderPage(page)
    expect(html).not.toContain('<title>')
  })

  it('includes script tag when js is present', async () => {
    const page = leaf('<p></p>', '', 'alert(1)', 'page')
    const html = await renderPage(page)
    expect(html).toContain('<script type="module">alert(1)</script>')
  })

  it('omits script tag when js is empty', async () => {
    const page = leaf('<p></p>', '', '', 'page')
    const html = await renderPage(page)
    expect(html).not.toContain('<script')
  })

  it('includes head tags from page template', async () => {
    const page: ResolvedComponent = {
      template: () => ({
        html: '<p>content</p>',
        css: '',
        js: '',
        head: '<link rel="icon" href="/favicon.svg">\n<link rel="preconnect" href="https://fonts.example.com">',
      }),
      children: [],
      treePath: '',
    }
    const html = await renderPage(page)
    expect(html).toContain('<link rel="icon" href="/favicon.svg">')
    expect(html).toContain('fonts.example.com')
  })

  it('scope IDs are deterministic across renders', async () => {
    const page = composite(
      children => ({ html: children.map(c => c.html).join(''), css: children.map(c => c.css).join(''), js: '' }),
      [leaf('<p>child</p>', '.p {}', '', 'child')],
      'page',
    )
    const html1 = await renderPage(page)
    const html2 = await renderPage(page)
    // Same tree path → same scope ID → same HTML
    const id = hashPath('child')
    expect(html1).toContain(`data-gz="${id}"`)
    expect(html2).toContain(`data-gz="${id}"`)
  })

  it('injects metadata title and description into <head> when template omits them', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, {
      metadata: { title: 'My Page', description: 'A test page' },
    })
    expect(html).toContain('<title>My Page</title>')
    expect(html).toContain('<meta name="description" content="A test page">')
    expect(html).toContain('<meta property="og:title" content="My Page">')
    expect(html).toContain('<meta property="og:description" content="A test page">')
  })

  it('injects og:image and canonical link when provided', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, {
      metadata: { ogImage: 'https://example.com/img.jpg', canonical: 'https://example.com/' },
    })
    expect(html).toContain('<meta property="og:image" content="https://example.com/img.jpg">')
    expect(html).toContain('<link rel="canonical" href="https://example.com/">')
  })

  it('does not duplicate title when template already provides one', async () => {
    const page: ResolvedComponent = {
      template: () => ({ html: '<p>body</p>', css: '', js: '', head: '<title>Template Title</title>' }),
      children: [],
      treePath: 'page',
    }
    const html = await renderPage(page, {
      metadata: { title: 'Meta Title', description: 'desc' },
    })
    expect(html).toContain('<title>Template Title</title>')
    expect(html).not.toContain('<title>Meta Title</title>')
    // description should still appear since template didn't provide one
    expect(html).toContain('<meta name="description" content="desc">')
  })

  it('does not duplicate description when template already provides one', async () => {
    const page: ResolvedComponent = {
      template: () => ({
        html: '<p>body</p>',
        css: '',
        js: '',
        head: '<meta name="description" content="from template">',
      }),
      children: [],
      treePath: 'page',
    }
    const html = await renderPage(page, {
      metadata: { description: 'from metadata' },
    })
    expect(html).toContain('name="description" content="from template"')
    // metadata's name="description" should NOT be injected (template provided one)
    expect(html).not.toContain('name="description" content="from metadata"')
    // og:description should still be injected since template didn't provide that
    expect(html).toContain('property="og:description" content="from metadata"')
  })

  it('renders without metadata (backward compatible)', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page)
    expect(html).toContain('<p>body</p>')
    expect(html).not.toContain('og:title')
  })

  it('escapes special characters in metadata values', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, {
      metadata: { title: 'A & B <script>', description: 'He said "hello"' },
    })
    expect(html).toContain('A &amp; B &lt;script>')
    expect(html).toContain('content="He said &quot;hello&quot;"')
  })

  // --- Fallback chain tests ---

  it('title falls back to content.title + site name when metadata.title is empty', async () => {
    const page: ResolvedComponent = {
      template: () => ({ html: '<p>body</p>', css: '', js: '' }),
      children: [],
      treePath: 'page',
      content: { title: 'About Us' },
    }
    const html = await renderPage(page, { seo: { siteName: 'Gazetta' } })
    expect(html).toContain('<title>About Us — Gazetta</title>')
    expect(html).toContain('property="og:title" content="About Us — Gazetta"')
  })

  it('title falls back to content.title without suffix when siteName is absent', async () => {
    const page: ResolvedComponent = {
      template: () => ({ html: '<p>body</p>', css: '', js: '' }),
      children: [],
      treePath: 'page',
      content: { title: 'About Us' },
    }
    const html = await renderPage(page, { seo: {} })
    expect(html).toContain('<title>About Us</title>')
  })

  it('description falls back to content.description', async () => {
    const page: ResolvedComponent = {
      template: () => ({ html: '<p>body</p>', css: '', js: '' }),
      children: [],
      treePath: 'page',
      content: { description: 'A page about us' },
    }
    const html = await renderPage(page, { seo: {} })
    expect(html).toContain('name="description" content="A page about us"')
    expect(html).toContain('property="og:description" content="A page about us"')
  })

  it('canonical falls back to siteUrl + route', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { route: '/about', seo: { siteUrl: 'https://example.com' } })
    expect(html).toContain('href="https://example.com/about"')
    expect(html).toContain('property="og:url" content="https://example.com/about"')
  })

  it('strips trailing slash from siteUrl before appending route', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { route: '/about', seo: { siteUrl: 'https://example.com/blog/' } })
    expect(html).toContain('href="https://example.com/blog/about"')
    expect(html).not.toContain('blog//about')
  })

  it('og:image falls back to site defaultOgImage', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { seo: { defaultOgImage: '/images/default.jpg' } })
    expect(html).toContain('property="og:image" content="/images/default.jpg"')
  })

  it('metadata.ogImage overrides site defaultOgImage', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, {
      metadata: { ogImage: '/images/page.jpg' },
      seo: { defaultOgImage: '/images/default.jpg' },
    })
    expect(html).toContain('property="og:image" content="/images/page.jpg"')
    expect(html).not.toContain('default.jpg')
  })

  it('emits og:type=website and twitter:card', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { seo: {} })
    expect(html).toContain('property="og:type" content="website"')
    expect(html).toContain('name="twitter:card" content="summary"')
  })

  it('twitter:card is summary_large_image when og:image is resolved', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { metadata: { ogImage: '/img.jpg' } })
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
  })

  it('emits robots meta when metadata.robots is set', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { metadata: { robots: 'noindex, nofollow' } })
    expect(html).toContain('name="robots" content="noindex, nofollow"')
  })

  it('omits robots meta when metadata.robots is absent', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { metadata: {} })
    expect(html).not.toContain('name="robots"')
  })

  it('uses site locale for <html lang>', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { seo: { locale: 'fr' } })
    expect(html).toContain('<html lang="fr">')
  })

  it('defaults <html lang> to en when locale is absent', async () => {
    const page = leaf('<p>body</p>', '', '', 'page')
    const html = await renderPage(page, { seo: {} })
    expect(html).toContain('<html lang="en">')
  })

  it('metadata.title wins over content.title fallback', async () => {
    const page: ResolvedComponent = {
      template: () => ({ html: '<p>body</p>', css: '', js: '' }),
      children: [],
      treePath: 'page',
      content: { title: 'Content Title' },
    }
    const html = await renderPage(page, {
      metadata: { title: 'SEO Title' },
      seo: { siteName: 'Site' },
    })
    expect(html).toContain('<title>SEO Title</title>')
    expect(html).not.toContain('Content Title')
  })

  it('full fallback chain with all values populated', async () => {
    const page: ResolvedComponent = {
      template: () => ({ html: '<p>body</p>', css: '', js: '' }),
      children: [],
      treePath: 'page',
      content: { title: 'Fallback', description: 'Fallback desc' },
    }
    const html = await renderPage(page, {
      metadata: {
        title: 'SEO Title',
        description: 'SEO desc',
        ogImage: '/seo.jpg',
        canonical: 'https://example.com/page',
        robots: 'noindex',
      },
      route: '/page',
      seo: { siteName: 'MySite', siteUrl: 'https://example.com', locale: 'de', defaultOgImage: '/default.jpg' },
    })
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('<title>SEO Title</title>')
    expect(html).toContain('name="description" content="SEO desc"')
    expect(html).toContain('href="https://example.com/page"')
    expect(html).toContain('property="og:image" content="/seo.jpg"')
    expect(html).toContain('property="og:url" content="https://example.com/page"')
    expect(html).toContain('property="og:type" content="website"')
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain('name="robots" content="noindex"')
    expect(html).not.toContain('Fallback')
    expect(html).not.toContain('default.jpg')
  })
})

describe('rendering with the html tag', () => {
  it('a composite inserts its children unescaped while c.html stays a plain string', async () => {
    const seen: unknown[] = []
    const parent: ResolvedComponent = {
      template: ({ children = [], content }) => {
        seen.push(...children.map(c => c.html))
        return { html: html`<header data-t="${content?.title}">${children}</header>`, css: '', js: '' }
      },
      content: { title: '<x>' },
      children: [leaf('<b>logo</b>', '', '', 'logo'), leaf('<i>nav</i>', '', '', 'nav')],
      treePath: 'header',
    }
    const result = await renderComponent(parent)
    expect(seen.every(h => typeof h === 'string')).toBe(true)
    expect(typeof result.html).toBe('string')
    expect(result.html).toContain('data-t="&lt;x&gt;"')
    expect(result.html).toContain('<b>logo</b>')
    expect(result.html).toContain('<i>nav</i>')
    expect(result.html).not.toContain('&lt;b&gt;')
  })

  it('renderPage accepts an html tag result as the page html', async () => {
    const page: ResolvedComponent = {
      template: ({ children = [] }) => ({ html: html`<main>${children}</main>`, css: '', js: '' }),
      children: [leaf('<p>body</p>', '', '', 'p')],
      treePath: '',
    }
    const out = await renderPage(page)
    expect(out).toContain('<main><div data-gz=')
    expect(out).toContain('<p>body</p>')
  })
})
