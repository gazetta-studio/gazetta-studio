# Admin UI library

The admin's components and icons move off PrimeUI, whose new major versions are commercial, onto Reka UI primitives with Gazetta's own CSS, and Lucide icons. Resolves [#1542](https://github.com/gazetta-studio/gazetta-studio/issues/1542).

**Status**: design pass complete (2026-10-31), grilled Q1–Q12. Implementation not started.

**Companion docs:**
- [ADR-0018](../../docs/adr/0018-admin-ui-on-reka.md): the load-bearing decision (no PrimeUI; Reka UI with our own styles); supersedes [`design-decisions.md`](design-decisions.md) #13
- [`css-theming.md`](css-theming.md): today's token layering (`--p-*` → `--color-*`), `adminPreset`, the `admin/theme.css` load order; cut 2 rewrites it
- [`docs/customize-editor.md`](../../docs/customize-editor.md): the public `admin/theme.css` contract; cut 2 rewrites its token section
- [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md): stories as bot specs; cut 1's components get theirs
- [`design-component-ordering.md`](design-component-ordering.md): drag and drop uses `@formkit/drag-and-drop`, unaffected
- Research: the discovery comment on #1542 (licence terms, v4 maintenance, OpenVue, other libraries), and this round's comparisons of exit options, icon sets and Reka-based libraries (2026-10-31)

## Scope

**In v1:**
- Gazetta's own Vue components for the 11 kinds the admin uses, built on Reka UI primitives, styled with our own CSS on our tokens
- Lucide (`@lucide/vue`) SVG icons replacing primeicons
- `--color-*` (and new Gazetta tokens) as the only override namespace for `admin/theme.css`; `--p-*` goes
- Removing `primevue`, `@primeuix/*` and `primeicons` from the admin

**Out of v1:**
- New admin features or layout changes beyond what the restyle needs

**Non-goals:**
- Keeping today's Aura look (Q8)
- A site-facing component library: sites never shipped PrimeVue and still don't

## Discovery

Checked 2026-10-29 to 2026-10-31:
- `primevue` 5, `@primeuix/themes` 3, `@primeuix/styled` 1 and `primeicons` 8 are under the PrimeUI licence ("SEE LICENSE IN LICENSE.md"), which needs a licence key and an OEM licence when "third parties develop with the Software". The admin is on the MIT lines: `primevue` 4.5.5, `@primeuix/themes` 2.0.3, `@primeuix/styled` 0.7.4, `primeicons` 7.0.0 (`package-lock.json`). #1541 keeps Dependabot off the first three; `primeicons` 8 isn't on its ignore list.
- PrimeTek says 4.x gets security fixes only, with no end date. `primevue` 4.5.5 is from 2026-04-08; no 4.x release since.
- The admin imports 11 component kinds in 33 of its 52 `.vue` files: Button (31 imports), Dialog (15), InputText (6), ProgressSpinner, Listbox (3 each), Select, RadioButton, Checkbox (2 each), Toolbar, Splitter, Menu (1 each). No Tree or Drawer: `SiteTree.vue` and `ComponentTree.vue` are our own, so two of #13's four reasons no longer hold. No PrimeVue Toast, ConfirmDialog or Tooltip.
- Button variants in use: `severity` secondary, danger, success, warn; `text`, `link`, `outlined`, `rounded`; `size="small"`; `:loading`.
- 148 icon uses of 51 distinct `pi pi-*` icons: Button `icon=` props, class strings returned from script, and `<i>` elements; 45 of the 59 `<i>` icons lack `aria-hidden`. The service worker precaches the primeicons font.
- 47 distinct `--p-*` tokens are used, and `docs/customize-editor.md` tells site authors to override `--p-*` in `admin/theme.css`.

## Locked decisions

### Q1 — Gazetta never ships a non-MIT PrimeUI version

Gazetta ships the admin, with its UI library compiled in, inside the `gazetta` npm package, so a PrimeUI-licensed version would likely need an OEM licence, and users' own organisations may miss the Community licence's thresholds.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| Ask PrimeTek in writing whether open source CMS distribution needs OEM | An answer binds only today's terms (Community keys renew yearly), and users above the thresholds may still need their own |
| Get a legal reading | Costs money for a question "never" already answers |

### Q2 — Until the move lands, stay on the MIT lines

`primevue` 4.5.5, `@primeuix/themes` 2.0.3, `@primeuix/styled` 0.7.4 and `primeicons` 7.0.0 stay; `primeicons >=8` joins Dependabot's ignore list.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| Take the PrimeUI-licensed majors meanwhile | Ruled out by Q1 |

### Q3 — Move now; no trigger to wait for

The admin moves off PrimeUI now. An earlier answer the same day set triggers for leaving (an unfixed advisory on 4.x, or a Vue release that breaks it); the later "Start now" answer replaced it.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| Leave only when a trigger fires | A weeks-long rewrite would start during a security incident |
| Plan it after the Stage 1 gate, with OpenVue as an emergency bridge | The maintainer chose to start now |

### Q4 — `--color-*` is the override namespace; `--p-*` goes

Site authors override `--color-*` (and new Gazetta tokens such as radius) in `admin/theme.css`. `--p-*` is removed, and `docs/customize-editor.md` and `css-theming.md` change in the same cut that removes it (cut 2). An earlier answer the same day kept `--p-*` through an alias layer; the clean rebuild replaced it.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| Keep the `--p-*` names through our own alias layer | 47 tokens named after a removed library, kept for `admin/theme.css` files that don't exist in production yet |
| Tie the override names to whatever library is in use | The public contract would change whenever the library does |

The public docs change in cut 2, not after it. Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| All docs in cut 3, one cut behind | Between cuts 2 and 3, `docs/customize-editor.md` would tell authors to override tokens that do nothing; AGENTS.md and team rule 8 ask for docs in the same PR |

### Q5 — Reka UI with our own styles

The admin's components are built on Reka UI (MIT) primitives, styled with our own CSS. It's the option where we own the look and the token contract, so no vendor's licence or theme engine can affect the admin again; its primitives cover the 8 kinds that need one (Button, TextInput and Spinner are native elements), and RTL is built in.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| OpenVue (MIT fork of PrimeVue 4.5.5) | A 3.5-month-old volunteer fork of the same vendor engine |
| Element Plus | Its own look and tokens; no Listbox or Toolbar; RTL undocumented |
| Vuetify | Its own (Material) look; no Splitter |
| Quasar | A framework with its own setup and Sass theming |
| Naive UI | Themes are JS objects and dark mode is a prop, so neither `.dark` nor our CSS variables can drive it |
| Nuxt UI | Needs Tailwind v4 and brings its own `--ui-*` names; no generic Toolbar or spinner |
| Decide the destination when a trigger fires | The round would run under time pressure |

### Q6 — Lucide icons replace primeicons

`@lucide/vue` (ISC) SVG components replace primeicons, in cut 2 together with the components (Q12: icons change in the same files). The "switch icons now" answer was given while the components still waited for a trigger; Q3 then moved everything now. All 51 icons are covered; only the icons used are bundled, so nothing joins the offline precache; `aria-hidden` is the default; a wrong icon name fails type-checking.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| Keep primeicons 7 until a trigger moves the components | The maintainer chose to switch icons without waiting for one |
| Tabler webfont | 509 KB font (14× primeicons) in the precache; `aria-hidden` by hand; a typo shows a blank |
| Tabler SVG components | No `aria-hidden` default, nothing over Lucide |
| Phosphor | Its Vue components haven't had a release since 2024-04; its font is 147 KB with manual `aria-hidden` |
| Bootstrap Icons | A 134 KB font; one of our icons missing |
| Heroicons | Five of our icons missing; last release 2024-11 |
| Material Symbols | Apache-2.0, not MIT |
| Remix Icon | Its own licence since 2026-01 |
| Iconify | Fetches icons at runtime unless bundled, which breaks the offline shell; its sets are the ones above |

### Q7 — Our own CSS, with shadcn-vue as the structural model

Components are Reka primitives plus our own scoped CSS on our tokens and `.dark`. shadcn-vue (MIT, by Reka's maintainers) is the model for component structure and accessibility wiring; where its code is copied, its MIT notice is kept. Listbox and Toolbar, which shadcn-vue lacks, are written on Reka's primitives.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| shadcn-vue as-is, with Tailwind v4 | Adds Tailwind to an admin without it, against `css-theming.md`; copied files don't auto-update either way |
| Nuxt UI v4 as a dependency | A vendor look, its own `--ui-*` names, Tailwind and Iconify: the kind of dependency this move leaves |
| @typlog/ui or @smalt-ui/core (Reka with plain CSS) | Pre-1.0 or brand new, one maintainer, components missing |

### Q8 — Our own minimal look

The admin isn't restyled to match today's Aura look. We write the simplest clean CSS ourselves, following no library's look; colours must pass the Storybook axe gate in light and dark.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| Keep today's look | Recreating a vendor theme we're leaving |
| shadcn-vue's look in our CSS | The maintainer chose our own minimal styles |
| A UX design round first | Delays the move |

### Q9 — All 33 files switch at once

One cut switches every use, with PrimeVue never alongside the new components in the shipped admin.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| Kind by kind, both libraries side by side until the last cut | The maintainer chose to switch at once |
| Screen by screen | Components shared across screens get built partially several times |

### Q10 — No bridge while the move is under way

An advisory in PrimeVue 4 before the move lands is handled by finishing the move; no fork in between.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| Move the affected component first | Follows kind-by-kind order, which Q9 didn't choose |
| An OpenVue bridge | A second migration in the middle of the first |

### Q11 — An ADR plus this doc

[ADR-0018](../../docs/adr/0018-admin-ui-on-reka.md) records the move and supersedes `design-decisions.md` #13; this doc holds the decisions, the cut sequence and the components' spec.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| This doc only, #13 marked superseded | The load-bearing decision would have no ADR |

### Q12 — Build, switch, docs

Three cuts (Cut sequence): build the components with their stories first, then switch everything and remove PrimeUI in one PR (with the public docs, Q4), then the remaining docs.

Decided: maintainer, 2026-10-31 (#1593)

| Rejected | Why |
|---|---|
| One PR for everything | A very large review |

## The components

Follows from Q5–Q8. Cut 1 builds these under `apps/admin/src/client/components/ui/`, each with a `.stories.ts` covering every variant and state below in light and dark.

| Kind | Reka primitive | Variants and states the admin uses today |
|---|---|---|
| Button | none (native `<button>`) | default (primary), `secondary`, `danger`, `success`, `warn`, set dynamically too; `text`, `link`, `outlined`, `rounded`; small; icon-only (with an accessible label); loading (disabled, spinner); disabled; a count badge with a severity, including `info` (the site-health button, `CmsToolbar.vue`) |
| Dialog | Dialog | modal; title; close button, which can be turned off (`UnsavedDialog.vue`) or off while busy (`AssetDeleteConfirm.vue`); closing by clicking the backdrop where it's allowed today (`PublishPanel`, `HistoryPanel`, `AuditDrawer`); footer actions |
| TextInput | none (native `<input>`) | default, small |
| Spinner | none (SVG) | one size (1.5rem); `aria-label` |
| Listbox | Listbox | single select; keyboard |
| Select | Select | placeholder, selected, small, clearable |
| RadioGroup | RadioGroup | default |
| Checkbox | Checkbox | unchecked, checked, indeterminate (`PublishPanel.vue`) |
| Toolbar | Toolbar | start and end groups |
| Splitter | Splitter (SplitterGroup, SplitterPanel, SplitterResizeHandle) | horizontal; keyboard-resizable handle; initial sizes and minimum sizes as `EditorView.vue` sets them today (35/65, minimum 25/35) |
| Menu | DropdownMenu | items with icons; grouped sections with labels (per environment, `ActiveTargetIndicator.vue`); the active item marked; separator |

Icons are `@lucide/vue` components; a spinning icon gets our own CSS. RTL: components use CSS logical properties, and Reka's `ConfigProvider` takes the admin's `dir`.

## Foundational checks

- **Multi-instance, Scale, Auth + RBAC, Audit, Review, Hooks, Render, Validation, Cache, Collaboration:** no change; the admin's behaviour and API are untouched. Sites never shipped PrimeVue.
- **Themes:** admin theming only (`css-theming.md`); dark mode stays the `.dark` class on `<html>`; the Storybook axe gate checks contrast in light and dark.
- **Locale:** RTL through CSS logical properties and Reka's `dir`.
- **Plugin:** the `admin/theme.css` override contract changes from `--p-*` to `--color-*` (Q4); custom editors and fields mount into a plain element and don't use PrimeVue.
- **Offline:** the primeicons font leaves the service worker's precache; the app shell stays bundled.

## UX check

The admin keeps every screen, action, copy and `data-testid`; only the look changes (Q8), to our own minimal styles. Icon-only buttons keep an accessible label, and decorative icons are hidden from screen readers by default (Lucide), fixing the 45 `<i>` icons that lack `aria-hidden` today.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Our components for the 11 kinds on Reka primitives (The components), the tokens they use, `@lucide/vue` and `reka-ui` added; a story per component in light and dark passing the axe gate; nothing in the admin uses them yet; `primeicons >=8` added to Dependabot's ignore list (Q2) | — | component | Medium |
| 2 | Switch all 33 files and the 148 icons to the new components and Lucide in one PR; remove `primevue`, `@primeuix/*`, `primeicons`, `adminPreset` and the `--p-*` uses (including `main.ts`, `.storybook/preview.ts`, and the `woff2` precache line in `vite.config.ts`); tests that select PrimeVue classes (`.p-dialog` and others) or `pi pi-*` icons, or check the primeicons font, move to test ids (`tests/e2e/`: `unsaved-guard`, `deep-linking`, `publish`, `target-switch`, `a11y`, `production-offline`, the `PublishPanel` and `ComponentTree` page objects; `apps/admin/tests/Banner.test.ts`, `ComponentTree.test.ts`'s `pi-clone`); the admin unit tests that install PrimeVue from `primevue/config`; the `vendor-primevue` chunk in `vite.config.ts` and `tests/sw-build.test.ts`; `Banner.stories.ts` and `__storybook__/smoke.stories.ts`; `docs/customize-editor.md` (overriding `--color-*`) and its regenerated site page (`npm run docs:site`), and `css-theming.md` (Q4) | 1 | component + e2e | High |
| 3 | The remaining docs that name PrimeVue: `architecture.md`, `AGENTS.md`, `README.md`, `configurations.md`, `design-themes.md`, `design-offline.md`, `design-component-ordering.md`, `custom-editors.md` | 2 | docs | Low |

## Migration

No production users. An existing `admin/theme.css` that overrides `--p-*` stops having an effect after cut 2; the changelog and `docs/customize-editor.md` say to switch to `--color-*`.

## Open questions

1. Which new Gazetta tokens (radius, spacing, focus ring) join `--color-*` as overridable in `admin/theme.css`: cut 1 proposes, cut 2 documents in `docs/customize-editor.md`.

## Future directions

None.
