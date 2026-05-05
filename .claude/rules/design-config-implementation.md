---
paths:
  - "packages/gazetta/src/config/**"
  - "packages/gazetta/src/site-loader.ts"
  - "**/site.config.ts"
  - "**/gazetta.config.ts"
---

# Site config — Implementation

TS config (`gazetta.config.ts` + `site.config.ts`) shipped 2026-05; see [design-config.md](design-config.md) for the durable design and [ADR-0005](../../docs/adr/0005-typescript-config-format.md) for the format decision.

## Deferred items

| Item | Trigger to revisit |
|---|---|
| `gazetta migrate-config` CLI | No backwards compat per ADR-0005; pre-1.0 product. Operators rewrite by hand. Could ship later if a v1.x→v2.x flip needs it. |
| Per-site `.env.local` files | Concrete demand from a multi-site project with truly distinct secret sets |
| `gazetta build:config` JSON precompile (v1.5) | Cold-start latency pain on cloud deployments |
| Custom `--env-file` Gazetta flag | Operators use Node's built-in `--env-file` directly |
| Hot-reload for config changes (dev) | Locked in design-config.md Q4; lands when the dev-server file-watcher is extended for plugin `dispose()` lifecycle |

## Lessons learned

- **CLI dispatch can't be a separate cut from the consumer migration that exercises it.** The original plan split "migrate `examples/starter` to TS config" (Cut 5) from "update CLI handlers" (Cut 10) on the theory that CLI handlers are mechanical wiring landing late. In practice the starter migration couldn't be verified end-to-end (`gazetta dev`, `gazetta publish`) without the CLI already reading the new format — Cut 5 had no honest passing state without Cut 10's changes. Folded into one cut at implementation time. Future migrations: when a consumer cut needs an integration cut to demonstrate it works, they're one cut, not two.
