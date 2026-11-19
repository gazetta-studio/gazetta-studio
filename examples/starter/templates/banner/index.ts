import { z } from 'zod'
import { format, html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  heading: z.string().describe('Banner heading'),
  text: z.string().optional().describe('Supporting text'),
  buttonText: z.string().optional().describe('Button label'),
  buttonUrl: z.string().optional().describe('Button link URL'),
  background: z.string().meta(format.field('brand-color')).optional().describe('Background color (default: #667eea)'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => {
  const bg = content?.background ?? 'linear-gradient(135deg, #667eea, #764ba2)'
  return {
    html: html`<section class="banner" style="background:${bg}">
  <h2 class="banner-heading">${content?.heading ?? ''}</h2>
  ${content?.text ? html`<p class="banner-text">${content.text}</p>` : ''}
  ${content?.buttonText ? html`<a class="banner-btn" href="${content.buttonUrl ?? '#'}">${content.buttonText}</a>` : ''}
</section>`,
    css: `.banner { padding: 4rem 2rem; text-align: center; color: #fff; border-radius: 12px; margin: 2rem auto; max-width: 72rem; }
.banner-heading { font-size: 2rem; font-weight: 700; margin-bottom: 0.75rem; }
.banner-text { font-size: 1.125rem; opacity: 0.9; margin-bottom: 1.5rem; max-width: 36rem; margin-left: auto; margin-right: auto; }
.banner-btn { display: inline-block; padding: 0.75rem 2rem; background: #fff; color: #1a1a1a; border-radius: 8px; font-weight: 600; text-decoration: none; font-size: 0.9375rem; }
.banner-btn:hover { opacity: 0.9; }`,
    js: '',
  }
}

export default template
