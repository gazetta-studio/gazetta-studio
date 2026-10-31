# Admin

CMS admin frontend — Vue 3 shell with editor mounting and preview, built on our own components (`src/client/components/ui/`, on Reka UI primitives) and Lucide icons.

## Structure

- `src/client/` — Vue 3 SPA (stores, components, composables, router)
- `src/server/` — Dev server entry (`dev.ts`) + re-export of admin API (`index.ts`)
- `tests/` — API and Docker integration tests

## Commands

```bash
npm run dev      # start Vite dev server + API server
npm run build    # production build
npm test         # run tests
```
