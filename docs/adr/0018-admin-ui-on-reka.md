# The admin's UI is Reka UI primitives with our own styles; no PrimeUI

> Context: PrimeTek moved `primevue` 5, `@primeuix/themes` 3, `@primeuix/styled` 1 and `primeicons` 8 to the commercial PrimeUI licence (#1542). Decided in the design round of 2026-10-31; the details, the cut sequence and every rejected option are in [`design-admin-ui.md`](../../.claude/rules/design-admin-ui.md). Supersedes [`design-decisions.md`](../../.claude/rules/design-decisions.md) #13.

The decision: **the admin's components are Gazetta's own Vue components, built on Reka UI (MIT) primitives and styled with our own CSS on Gazetta's `--color-*` tokens; icons are Lucide (`@lucide/vue`, ISC). Gazetta never ships a PrimeUI-licensed version, and `--p-*` stops being the `admin/theme.css` override namespace.**

## Why

- **Distribution.** Gazetta ships the admin, with its UI library compiled in, inside the `gazetta` npm package. PrimeUI's terms ask for an OEM licence when "third parties develop with the Software", and users' own organisations may not meet the free Community licence's thresholds. An MIT-only admin needs no reading of those terms.
- **Ownership.** With headless primitives and our own CSS, no vendor's licence change or theme engine reaches the admin again, and the token contract site authors override is Gazetta's.
- **Fit.** Reka's primitives cover the 8 of the admin's 11 component kinds that need one, including Splitter, Listbox and Toolbar (Button, text input and spinner are native elements), and handle RTL through `dir`.
- **#13 had drifted.** It chose PrimeVue for Tree, Splitter, Drawer and Toolbar. The admin's trees are its own, and it uses no Drawer.

## What was rejected

- **Stay on PrimeVue 4.5.5 until something forces a move:** 4.x gets security fixes only, with none released since 2026-04-08, and a rewrite started by an advisory would run under pressure.
- **OpenVue (an MIT fork of PrimeVue 4.5.5):** the smallest migration, but a 3.5-month-old volunteer fork of the same vendor engine.
- **A styled MIT library (Element Plus, Vuetify, Quasar, Naive UI, Nuxt UI):** each brings its own look and tokens plus gaps in our component set; Naive UI can't be driven by a `.dark` class or CSS variables; Nuxt UI needs Tailwind.
- **shadcn-vue as-is:** built on Reka and Lucide by Reka's maintainers, but needs Tailwind v4. It stays the structural model for our components.

## Consequences

- The admin's look changes to our own minimal styles; screens, copy and test ids don't.
- `admin/theme.css` files that override `--p-*` stop having an effect; they switch to `--color-*`.
- The admin owns the CSS and the accessibility of 11 components; the Storybook axe gate checks contrast in light and dark.
