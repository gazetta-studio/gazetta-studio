# Pluggable provider pattern for cross-cutting concerns

Storage, Cache, Audit, AltText (AI), Transform Adapter, Deploy Adapter, Validator, AuthIdentity, Hook, Admin Editor, Admin Field — 11 cross-cutting concerns are pluggable through typed interface + multiple in-tree Providers + (future) npm-packaged Plugins. Operators pick implementations via `site.yaml`; consumers depend on abstractions, not concrete classes.

We picked this over hardcoded implementations because: operator deployments span very different infrastructure (filesystem, R2, S3, Azure Blob; Cloudflare, Azure, AWS auth; etc.); the consistent shape across surfaces means each new surface ships with a predictable contract; in-tree Providers can promote to npm-packaged Plugins additively without breaking existing consumers. The cost is more interfaces than a hardcoded approach, but the consistency makes Gazetta debuggable across deployments and future surfaces extensible without re-architecting.

## Consequences

Every cross-cutting concern that touches infrastructure-or-vendor-specific behavior is structured this way. The universal Provider requirements (multi-instance correctness, env-var credentials, fail-mode declared, never-throw-on-transport-errors at recording layer, stable typed contract, independent error taxonomy, sensible defaults, stateless interface) are documented in `design-plugins.md` and apply to every surface. Per-surface contracts live in their respective `design-{surface}.md`.

Operator config consistency is a deliberate outcome: every Provider follows `provider: name` (or `providers: [...]` for multi-Provider surfaces) + minimal yaml + env-var credentials. Operators learn one pattern and apply it across surfaces.
