import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  label: z.string().describe('Button label'),
  start: z.number().optional().describe('Starting count'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => {
  const { label = 'Count', start = 0 } = content ?? {}
  // Use a unique ID so multiple counters on one page don't collide
  const id = `counter-${Math.random().toString(36).slice(2, 8)}`
  return {
    html: html`<div class="counter" id="${id}">
  <span class="counter-value">${start}</span>
  <button class="counter-btn" data-action="decrement">−</button>
  <button class="counter-btn" data-action="increment">+</button>
  <span class="counter-label">${label}</span>
</div>`,
    css: `.counter { display: inline-flex; align-items: center; gap: 0.5rem; padding: 1rem 1.5rem; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
.counter-value { font-size: 2rem; font-weight: 700; min-width: 3rem; text-align: center; }
.counter-btn { width: 2.5rem; height: 2.5rem; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; font-size: 1.25rem; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.counter-btn:hover { background: #e5e7eb; }
.counter-btn:active { background: #d1d5db; }
.counter-label { font-size: 0.875rem; color: #6b7280; }`,
    js: `{
  const el = document.getElementById('${id}')
  const display = el.querySelector('.counter-value')
  let count = ${start}
  el.querySelector('[data-action="increment"]').addEventListener('click', () => {
    display.textContent = ++count
  })
  el.querySelector('[data-action="decrement"]').addEventListener('click', () => {
    display.textContent = --count
  })
}`,
  }
}

export default template
