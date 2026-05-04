# TypeScript config format with global + per-site split

`gazetta.config.ts` (global, optional) and `sites/{name}/site.config.ts` (per-site, required) replace `site.yaml`. Both use typed identity functions (`defineGazetta`, `defineSite`) for IDE autocomplete + compile-time validation. Plugin imports happen inside the config file at the call site; secrets stay in env vars per Universal Provider Requirement #3.

We picked TypeScript over YAML because plugins need callbacks-as-config (a YAML-impossible shape), modern CMSes (Sanity, Payload, Astro, Next.js, Strapi) all use config-as-code, type-safety eliminates a class of "shipped wrong config" bugs, and per-environment branching (`if (process.env.NODE_ENV === 'production')`) belongs at the call site rather than in a separate merge layer. The cost is YAML's GitOps-friendliness (yq/jq inspection, declarative pipelines) — accepted because Gazetta's audience is developer-operators, not pure-ops.

We picked global + per-site split (not single root config with site map) because per-site editing localizes git history, plugin imports stay scoped to the sites that use them, and different sites can have different deployment cadence. Global config is for project-level settings (telemetry, log level, dev port, MCP server, default cache/audit providers); site config is for per-site concerns (targets, dimensions, auth, plugins, hooks, audit). Defaults flow from gazetta → site for object fields; arrays (plugins, hooks) are explicit per site (no inheritance).

We picked `defineSite()` / `defineGazetta()` identity-function exports over plain object exports because identity functions with generic constraints preserve literal types for the best IDE autocomplete (the Sanity / Astro / Vite / Vitest pattern). Runtime Zod validation still runs on every load — TS catches shape errors at edit time; Zod catches env-var-driven errors at load time. Defense in depth.

## Consequences

`site.yaml` is removed at hard cutover. No coexistence period; supporting both formats invites drift. The implementation PR ships `gazetta migrate-config` CLI that reads `site.yaml` and writes `site.config.ts`. Operators run it once per site.

Production loads config once at boot; restart applies changes. `gazetta dev` watches `gazetta.config.ts` and `sites/*/site.config.ts` and reloads on save (plugins receive `dispose()` before reinit). Build-time JSON precompile (`gazetta build:config` → `.gazetta/built-config.json`) is a v1.5 ergonomic improvement to reduce cold-start latency on cloud deployments — not v1 critical.

Secrets stay in env vars per the existing convention (provider SDK names like `AWS_REGION`, `R2_BUCKET`, `ANTHROPIC_API_KEY`; `GAZETTA_*` prefix for Gazetta-specific salts and tokens). `process.env.X` is the in-config reference pattern; no Gazetta-specific env wrapper. Inline-secret detection is deferred to existing tools (gitleaks, git-secrets, pre-commit hooks).

Every design doc with `site.yaml` examples (~30 files) gets swept to TS examples in the implementation PR alongside the config loader code. `design-config.md` reference doc captures the patterns operators and plugin authors need; it's a reference doc, not a foundational dimension (config format is set once, not an ongoing concern that recurs in feature designs).
