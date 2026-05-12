# Storybook

Component isolation surface for `apps/admin/`. Boot with `npm run storybook` from the repo root; opens at http://localhost:6006.

## What Storybook is for (and what it's NOT)

| Use Storybook | Don't use Storybook |
|---|---|
| Develop a Vue SFC in isolation without booting the full admin | End-to-end / scenario tests — that's Playwright (`tests/e2e/`) |
| See every variant of a component side-by-side in light + dark mode | Functional regression coverage — that's Vue Test Utils (`tests/*.test.ts`) |
| Document the prop shape + emits + visual states | Template-developer surfaces — that's `DevPlayground.vue` |

Storybook is a maintainer-facing tool for admin SFC development. Template developers (site authors building custom templates) use the in-tree `DevPlayground.vue` (`/admin/dev` in a running admin) — different audience, different concerns. See `.claude/rules/design-validation.md` Cut 6 for the template-developer surface.

## File layout

```
.storybook/
  main.ts         # Storybook config — story glob, addons, Vite plugin overrides
  preview.ts      # Per-preview setup: Pinia, PrimeVue, tokens.css, theme decorator

apps/admin/src/client/
  components/
    ArchiveBanner.vue
    ArchiveBanner.stories.ts        # <-- next to its component
    ...
  __storybook__/
    smoke.stories.ts                # bootstrap smoke story; no real component
```

**Convention**: each story file lives next to its `.vue` source as `Foo.stories.ts`. The `__storybook__/` dir is reserved for stories that aren't paired with a single SFC (e.g., the boot smoke test).

## Adding a new story

Three patterns, in order of complexity:

### Pure props

When the component takes only props (no Pinia stores, no router, no API). See [`AssetFocalPointEditor.stories.ts`](src/client/components/AssetFocalPointEditor.stories.ts) for a worked example.

```ts
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import MyComponent from './MyComponent.vue'

const meta: Meta<typeof MyComponent> = {
  title: 'Category / MyComponent',
  component: MyComponent,
  args: { /* shared defaults */ },
  argTypes: {
    'onUpdate:modelValue': { action: 'update:modelValue' },
  },
}
export default meta

type Story = StoryObj<typeof MyComponent>

export const Default: Story = { args: { modelValue: null } }
```

### Complex prop objects

When the component takes structured object props. See [`ConflictDiffView.stories.ts`](src/client/components/ConflictDiffView.stories.ts).

Same shape as pure props; just pass real-shape objects to `args`. Don't unwrap them through `argTypes` controls — Storybook's object control is fine for one-off tweaks but the canonical story is the typed `args` value.

### Pinia store seeding

When the component reads from a store. See [`ValidationBanner.stories.ts`](src/client/components/ValidationBanner.stories.ts).

```ts
function seedIssues(issues: readonly ValidationIssue[]) {
  return () => ({
    components: { ValidationBanner },
    setup() {
      const validation = useValidationIssuesStore()
      validation.clear()
      validation.set(issues)
    },
    template: '<ValidationBanner />',
  })
}

export const SingleError: Story = {
  render: seedIssues([{ ... }]),
}
```

Key points:
- `preview.ts` installs Pinia once per preview boot via `app.use(createPinia())`. The instance is shared across all stories.
- Inside `setup()`, call the store you want to seed and mutate its state directly. Stores expose `ref`s in the setup-function pattern, so direct assignment (`site.pages = [...]`) or method calls (`validation.set(...)`) both work.
- **Always reset state at the top of `setup()`** with `.clear()` or equivalent. Without this, prior stories' state leaks into yours (Storybook reuses the same Pinia instance across navigations).
- If cross-story leakage shows up at scale, switch to [`createTestingPinia`](https://pinia.vuejs.org/cookbook/testing.html) per story — fresh instance per render. Defer until proven necessary; the explicit reset works for v1.

### Multi-store seeding

When the component composes two or more stores. See [`ArchiveBanner.stories.ts`](src/client/components/ArchiveBanner.stories.ts).

Same as single-store: just call each `useXStore()` inside `setup()` and seed each.

## Theme toggle

The toolbar's theme switcher (top of the Storybook UI) flips between `light` and `dark` by toggling the corresponding class on `<html>`. PrimeVue Aura's `darkModeSelector: '.dark'` is configured in `preview.ts` so all Aura semantic tokens (`--p-text-color`, `--p-content-background`, `--p-primary-color`, etc.) re-resolve when the class flips.

Verify every story renders correctly in **both themes**. Per `.claude/rules/team-preferences.md` rule 14: every UI change must be tested in both themes before committing.

## Things to know

### Vue SFC plugin

`@storybook/vue3-vite`'s built-in `viteFinal` adds Storybook's own template-compilation + vue-docgen plugins but NOT the standard `@vitejs/plugin-vue` SFC transform. Without it, importing a `.vue` file from a story 404s. `.storybook/main.ts` adds the plugin via `viteFinal` so stories resolve SFCs identically to the running admin app.

### Vue Router + API calls are not provided by default

`preview.ts` deliberately does NOT install Vue Router, Vue Query, the service worker, or IndexedDB persistence — these are real in `main.ts` but unnecessary for component rendering and add startup cost.

Components that use `useRouter()` / `useRoute()` will fail to mount without a router stub. When a future story needs router, the pattern is to install a stub router inside the story's `setup()`:

```ts
import { createRouter, createMemoryHistory } from 'vue-router'

setup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [...] })
  // ... use within the story
}
```

Components that fire `api.foo()` on mount will hit the network (and fail). Mock per-story with a `vi.fn()` or use `msw` for HTTP interception. v1 deferred these patterns until a story actually needs them.

### Smoke story

`apps/admin/src/client/__storybook__/smoke.stories.ts` renders a PrimeVue `Button` with no admin-component dependency. A regression here means the Storybook setup itself is broken (preview decorators, plugin registration, theme decorator) — not an admin component. Keep it as the canary.

### Story title convention

`Category / ComponentName`. Examples in the codebase:

- `Smoke / PrimeVue Button` (the boot canary)
- `Asset / FocalPointEditor`, `Asset / AltEditor`
- `Validation / Banner`
- `Archive / ArchiveBanner`
- `Offline / ConflictDiffView`

Category mirrors the design-doc namespace where the component's behavior is specified.

### What's deferred

Per the Cut 1-3 plan, these are NOT in the initial Storybook surface; revisit when concrete demand surfaces:

- **`@storybook/addon-vitest`** — Storybook 10's vitest addon defaults to browser-mode via Playwright Chromium, which would conflict with the existing jsdom test suite. Adopt later as a separate vitest project config.
- **Visual regression snapshots** (Chromatic / `toHaveScreenshot`) — per `.claude/rules/css-theming.md`'s visual-testing decision, deferred until the admin stabilizes.
- **Stories for every component** — only 5 pilot stories ship in Cut 2, each chosen to stress-test a distinct integration pattern. New stories land alongside the feature cuts that touch the component, not as a backfill batch.
- **CI build of Storybook** (`build-storybook` in a workflow) — not gated yet; local-only.

### Adding a new dependency

If a future story needs a runtime helper or addon, add it to the root `package.json` `devDependencies` (Storybook lives at root per the workspaces' shared hoisting; see `.github/workflows/ci.yml`'s `admin` job context).
