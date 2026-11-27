import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Heading'),
  subtitle: z.string().optional().describe('Subheading'),
  badge: z.string().optional().describe('Small badge text above the title'),
  badgeHref: z.string().optional().describe('Badge link URL'),
  cta: z.string().optional().describe('Call to action text'),
  ctaHref: z.string().optional().describe('Call to action URL'),
  status: z.string().optional().describe('Project status line below the subheading'),
  statusLink: z.string().optional().describe('Link text after the status line'),
  statusHref: z.string().optional().describe('Status line link URL'),
})

const template: TemplateFunction = ({ content = {} }) => ({
  html: html`<section class="hero">
  <div class="hero-inner">
    ${content.badge ? html`<a href="${content.badgeHref ?? '#'}" class="hero-badge">${content.badge}</a>` : ''}
    <h1>${content.title ?? ''}</h1>
    ${content.subtitle ? html`<p class="hero-sub">${content.subtitle}</p>` : ''}
    ${content.status ? html`<p class="hero-status">${content.status}${content.statusLink ? html` <a href="${content.statusHref ?? '#'}">${content.statusLink}</a>` : ''}</p>` : ''}
    ${content.cta ? html`<a href="${content.ctaHref ?? '#'}" class="hero-cta">${content.cta}</a>` : ''}
  </div>
</section>`,
  css: `.hero { padding: 4rem 2rem 2rem; text-align: center; }
.hero-inner { max-width: 48rem; margin: 0 auto; }
.hero h1 { font-size: 3.5rem; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; background: linear-gradient(135deg, #a78bfa, #6d28d9); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.hero-sub { font-size: 1.25rem; color: #a1a1aa; margin-top: 1.5rem; max-width: 36rem; margin-left: auto; margin-right: auto; }
.hero-status { font-size: 0.875rem; color: #a1a1aa; margin-top: 1rem; }
.hero-status a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.hero-status a:hover { color: #e4e4e7; }
.hero-cta { display: inline-block; margin-top: 2rem; padding: 0.75rem 2rem; background: #7c3aed; color: white; border-radius: 8px; font-weight: 600; transition: background 0.15s; }
.hero-badge { display: inline-block; margin-bottom: 1.5rem; padding: 0.375rem 1rem; background: #1c1c2e; border: 1px solid #2d2d44; border-radius: 999px; font-size: 0.8125rem; color: #a78bfa; font-weight: 500; }
.hero-badge:hover { background: #252540; color: #c4b5fd; }
.hero-cta:hover { background: #6d28d9; color: white; }`,
  js: '',
})

export default template
