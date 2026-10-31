# CSS and Theming (apps/admin)

How the admin SPA handles colours, dark mode and design tokens. The admin's components are our own (`apps/admin/src/client/components/ui/`, on Reka UI primitives) and its icons are `@lucide/vue` SVG components; no CSS framework or vendor theme is involved ([`design-admin-ui.md`](design-admin-ui.md), ADR-0018).

## Tokens

`apps/admin/src/client/assets/tokens.css` is the only place colour, radius, focus and overlay values live. Every token has a literal light value on `:root` and, where it differs, a dark value on `.dark`. Components and screens reference tokens, never literal colours.

| Group | Tokens |
|---|---|
| Surfaces and text | `--color-bg`, `--color-fg`, `--color-muted`, `--color-border`, `--color-hover-bg`, `--color-input-bg`, `--color-input-border`, `--color-bg-chip`, `--color-bg-code` |
| Brand | `--color-primary` / `--color-on-primary`, `--color-accent` (component-tree selection) |
| Severity | `--color-danger`, `--color-success`, `--color-warn`, `--color-info`, each a fill and a text colour, with `--color-on-<name>` for text on the fill |
| Status banners | `--color-{danger,success,warning,info}-{bg,fg}` |
| Environments | `--color-env-{prod,staging}-{bg,fg}` |
| Change marks | `--color-change-{added,modified,deleted}` |
| Shape and focus | `--radius-{xs,sm,md,full}`, `--focus-ring-width`, `--focus-ring-offset`, `--color-focus-ring` |
| Overlays and type | `--color-overlay`, `--shadow-overlay`, `--font-mono` |

Every colour pair the admin draws (text on its background, `--color-on-<name>` on `--color-<name>`) must pass WCAG AA in light and dark. The Storybook gate checks it: every story runs in both themes with axe `color-contrast` as a hard failure (`vitest.storybook.config.ts`, `a11y: { test: 'error' }` in `.storybook/preview.ts`).

Add a token when a colour appears in 3+ places or names a concept; otherwise reuse the closest existing one.

## Theme switching

`useThemeStore.apply()` toggles both `dark` and `light` classes on `<html>` (one active at a time). The `.dark` block in `tokens.css` re-points the tokens, so components need no theme branches.

`.light` and `.dark` selectors in component CSS are both live, but prefer a token that flips over an explicit `.dark .foo` override.

## Do and don't

**Do:**
- Use `var(--color-*)` (and the radius, focus and overlay tokens) in component CSS
- Use the `components/ui/` components for buttons, dialogs, inputs, selects, menus, etc.; restyle them through their own classes, not by reaching into their internals
- Use CSS logical properties (`margin-inline-start`, `inset-block`) so RTL flips without extra rules
- Render icons as Lucide components; they are `aria-hidden` by default, and icon-only controls carry an `aria-label`

**Don't:**
- Hard-code hex values for status or semantic colours (error, success, info): use tokens
- Apply theme values from JS (`:style="themeVars"`): it can't participate in `:hover`, media queries or the `.dark` cascade
- Add tokens in component CSS: they live in `tokens.css`

## Specificity and scoping

Vue SFC `<style scoped>` adds `[data-v-xxx]` attribute selectors. `.dark` and `.light` selectors in a scoped block keep their specificity — they work. For simplicity, put any `.dark .foo` override in an unscoped `<style>` block at the bottom of the SFC.

Reka teleports dialog, select and menu content to `<body>`. Scoped styles still reach elements rendered by the component's own template; where Reka creates the element itself (the menu and select content), the ui component styles it with an unscoped block whose classes carry a `ui-` prefix.

## User theming

`admin/theme.css` lets site authors override tokens with static CSS, no API. Load order: `tokens.css` → the user's `theme.css`, which `main.ts` appends after `app.mount()` so it wins the cascade; the server answers an empty stylesheet when the file doesn't exist. The public contract is in [`docs/customize-editor.md`](../../docs/customize-editor.md).

**Reserved prefixes:** `--color-*`, `--radius-*`, `--focus-ring-*`, `--shadow-*`, `--font-*` belong to Gazetta (override existing, don't add new). Authors pick their own prefix for custom editor and field tokens (`--myapp-*`).

## Don't use

- **Tailwind / UnoCSS** — overkill for the admin's component CSS
- **CSS Modules** — Vue `<style scoped>` is equivalent
- **A component library's theme engine** — the admin left PrimeVue for its licence change; our components plus `tokens.css` keep the look and the token contract ours (ADR-0018)
- **Custom spacing scales** — not needed at the admin's size

## Visual testing (deferred)

We tried a Playwright `toHaveScreenshot` baseline for PublishDialog and dropped it. Reasons to revisit later, not now:

**Why we dropped it:**
- Baselines are per-platform. CI is Linux, local dev is macOS — every dev needs docker to regenerate before commit, or only CI can update baselines (friction either way).
- Every intentional visual change requires re-baselining. For a prototype UI moving fast, the maintenance tax outpaces the regression-catching value.
- Catches pixel-level regressions but misses semantic regressions (a button moved to the wrong place but still renders). A11y / semantic tests catch more real bugs.
- Site developers using Gazetta as an npm dependency never run our e2e suite — the snapshots only protect Gazetta core development, not their projects.

**Alternatives when we need visual regression:**

| Need | Tool |
|---|---|
| Catch unintended visual changes in core admin | Playwright `toHaveScreenshot` with CI-generated baselines. Gate to `process.platform === 'linux'` and commit only Linux PNGs. Regenerate via `docker run mcr.microsoft.com/playwright:vX.Y.Z-jammy ... --update-snapshots` |
| Explore component variants while designing | The existing `/admin/dev` playground. Extend with fixture props if needed. |
| Design-system-level visual review | **Storybook is installed** (`@storybook/vue3-vite`, `npm run storybook`, existing `.stories.ts` files) — this "not worth the setup until 40+ components" note is stale; disregard it. Storybook's role + the DevPlayground-vs-Storybook coherence split are defined in [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md) (stories as bot-executable UX specs). Dedicated *visual-regression* (`toHaveScreenshot`) testing remains deferred per the rows above — that's a separate concern from component stories. |
| Site developers catching their own regressions | They write their own Playwright tests against the running admin using our `data-testid` attributes |

**When to reintroduce:**
- Core admin stabilizes and visual changes are intentional, rare
- Gazetta core gains a contributor who needs design-review workflows
- A specific visual regression is found in the wild and warrants a regression test
