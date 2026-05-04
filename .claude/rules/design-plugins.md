---
paths:
  - "packages/gazetta/src/providers/**"
  - "packages/gazetta/src/alt/*.ts"
  - "packages/gazetta/src/transforms/**"
  - "packages/gazetta/src/editor/mount.tsx"
  - "**/templates/**/index.tsx"
  - "**/admin/editors/**"
  - "**/admin/fields/**"
---

# Plugin / extensibility — design pass pending

Foundational dimension #8 of 10. Unifying contract for the existing extension surfaces — discovery, loading, lifecycle, composition.

**Status**: design pass pending — sequenced 8 of 8 (after `design-hooks.md`; hooks are likely the integration point). See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Plugin check** every new extension surface must answer
- [`design-hooks.md`](design-hooks.md) — hooks are an extension surface; plugins likely register hooks via this contract

## Why this is foundational

Today, nine extension surfaces exist (storage providers, templates, custom editors, custom field widgets, transform adapters, deploy adapters, AI providers, validators, cache providers) plus hooks (incoming). Each has its own interface contract. Without a unifying plugin contract, future surfaces (whatever 11th or 12th surface gets added) drift toward their own ad-hoc plug-in pattern. Unifying later is structural rework.

Strategic commitment locked: **plugins are foundational** (resolved from "open question"). The named surfaces ARE the plugin system. The unifying contract formalizes how they compose.

## Locked invariants (already decided)

- **Existing surfaces stay distinct interfaces** — `StorageProvider`, `EditorMount`, `FieldMount`, `AltTextAdapter`, `TransformAdapter`, etc. The plugin contract doesn't replace them; it provides discovery + loading + composition rules on top.
- **MCP schema discipline** — new admin-API routes use the existing Zod schema pattern. MCP tooling auto-generates from these. Plugin contract respects this — plugins that add admin-API routes follow the schema pattern.
- **Real-time event-source discipline** — plugins that observe save/publish do so via audit log, not by patching handlers. Per `feature-design-process.md` non-foundational disciplines.

## Open questions for the design pass

### Multi-instance check
- Plugin discovery + loading happens at admin boot; each instance loads its own plugin set independently. Plugins are file-based (npm packages or site-local), so all instances see the same plugins.
- Plugin state — plugins MUST NOT hold state in process across operations. Any state goes through storage (using the same multi-instance-safe patterns the core uses: per-edge sidecars, content-addressed blobs, atomic writes).
- Plugin discovery for a hot-deployed plugin (added without admin restart) — out of v1 scope. v1 plugins require admin restart on each instance to pick up changes.
- Plugin-contributed extensions (storage providers, AI adapters, validators, etc.) inherit the multi-instance discipline of their host surface — a plugin-supplied storage provider must be as multi-instance-safe as the in-tree providers.

### Discovery
- Where do plugins live? npm packages (registered in `package.json`)? Site-local in `admin/plugins/`? Both?
- How are they discovered? Auto-discovered from `package.json` field? Explicit config in `site.yaml`?
- Versioning — peer dependency on `gazetta`? SemVer compatibility checks at load time?

### Loading lifecycle
- When do plugins load? At admin boot? Lazy on first use of their surface?
- Plugins that need init (network connection, credential validation) — async init?
- Failure mode — fail boot? Log and skip? Surface error in admin UI?

### Composition
- Multiple plugins extending the same surface (two storage providers, two AI providers) — how chosen?
  - Today: `site.yaml` config picks one per surface. Plugins extend the catalog of options.
- Plugins that add new surfaces (e.g., a plugin that adds a "search backend" surface) — out of scope for v1?

### Sandbox / trust
- Plugins run with full Node access (current model — npm packages have no sandbox) — accept and document
- Per-plugin permission model — out of scope for v1
- Code review for plugin marketplace listings — out of scope

### API contract per surface
- Is the contract per-surface (current — each surface has its own interface) or unified ("everything's a plugin with `name`, `init`, `dispose`")?
- Per-surface keeps existing code working; unified is cleaner. Probably per-surface with a thin meta-layer for discovery + lifecycle

### Plugin payload
- What does a plugin export? A constructor function? A registration object? Default export?
- TypeScript types for plugin authors — exported from `gazetta/plugin`?

### Composition with hooks
- Hooks are one surface a plugin can extend. The plugin loads → registers its hooks → audit log records hook firings as actor=plugin-name?

### Composition with each foundational dimension
- **Scale**: plugins must respect the operating envelope; heavy plugins flagged
- **Locale + Themes**: plugins that touch render output respect locale/theme dimensions
- **RBAC**: plugin-added admin actions gate on roles
- **Audit log**: plugin actions recorded
- **Render**: plugins respect render-mode taxonomy

## Migration

Existing surfaces continue to work — plugin contract is additive on top. The migration is per-surface as the contract is applied:
- Built-in storage providers (filesystem, R2, S3, Azure) become "in-tree plugins" registered the same way external plugins would be
- Templates / custom editors / custom fields stay where they are; the contract applies to npm-packaged versions

## Future directions

- Plugin marketplace — npm registry filter, curated listings — out of scope for v1
- Custom routes / custom CLI as plugin surface — strategic non-fit per ROADMAP non-goals (waits for concrete demand)
- Plugin hot-reload — out of scope; reload requires admin restart
