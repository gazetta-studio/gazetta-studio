---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "packages/gazetta/src/cache/**"
  - "**/cache*"
---

# Cache — design pass pending

Foundational dimension #11 of 12. Pluggable caching layer with multiple provider implementations (memory, Redis, Azure storage, future others). v1 ships memory-only; the abstraction is in place from day one so multi-instance deployments can swap to a shared provider without changing consumers.

**Status**: design pass pending — reuses the extension-surface pattern from plugins; extended by browser-side providers in `design-offline.md`. See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Cache check** every new feature design must answer
- [`design-plugins.md`](design-plugins.md) — sibling extension-surface design; cache providers are one of the named surfaces
- [`design-scale.md`](design-scale.md) — first major consumer (`/api/pages`, `/api/fragments`, `/api/dependents`)

## Why this is foundational

Caching is foundational because:

1. **It's load-bearing for performance.** Several primitives at scale (admin's `/api/pages`, `/api/fragments`, fragment-resolution, future filtered listings) need caching to hold the latency SLA. Caching ad-hoc per-feature creates inconsistent semantics + invalidation bugs.

2. **Multi-instance correctness depends on the cache shape.** A per-instance in-memory cache is fine for single-process deployments; a multi-instance deployment needs a shared cache provider (Redis, Azure storage, distributed cache) OR explicit per-instance scope with carefully designed invalidation. Getting this wrong silently corrupts state — exactly the class of bug the multi-instance discipline exists to prevent.

3. **It's an extension surface.** Operators choose memory vs. Redis vs. Azure vs. file-based per their deployment shape. Same pattern as storage providers, AI providers, transform adapters — pluggable behind one interface.

## Locked invariants

These are committed even before the design pass formalizes:

- **`AdminCache` is the abstraction** — features that cache data go through it; no ad-hoc memos in feature code. Features that don't cache (most validators, hooks, save handlers) don't touch this surface.
- **Provider-pluggable** — `MemoryCache` ships as v1 default; Redis, Azure storage, file-based, distributed providers slot in via the same interface. Operator picks per `site.yaml admin.cache` config.
- **Multi-instance discipline holds**:
  - `MemoryCache` is per-instance scope (multi-instance-correct via per-instance independence; eventual consistency across instances acceptable because each receives SSE invalidation events for its own writes).
  - Shared providers (Redis, Azure storage) are multi-instance-correct via the provider's own coordination (Redis atomic ops, Azure storage etag-based writes).
  - In-process caches OUTSIDE `AdminCache` are governed by the existing multi-instance discipline: scoped to one operation (per-build, per-request) only.
- **Cache invalidation is explicit, not TTL-only**. The save / publish path invalidates affected cache keys; TTL is a fallback safety net, not the primary invalidation mechanism. Eventual consistency at the staleness window of `min(TTL, next-SSE)` is acceptable.
- **Provider supports prefix-invalidation** — `cache.invalidate('pages:')` clears all `pages:*` entries. Required because save-time invalidation often clears a related set, not a single key.
- **Storage-as-cache is allowed.** A cache provider is allowed to use the existing `StorageProvider` abstraction (e.g., `FileCache` writes to a `.gazetta/cache/` directory, or `AzureCache` writes to a separate cache container). The same multi-instance discipline applies — file-based caches use atomic write-then-rename per the provider contract.

## Cache shape (sketched, refined in design pass)

```ts
export interface AdminCache {
  /** Get cached value or null on miss. */
  get<T>(key: string): Promise<T | null>
  /** Set value with optional TTL (seconds). Provider may ignore TTL if it doesn't support expiry. */
  set<T>(key: string, value: T, opts?: { ttl?: number }): Promise<void>
  /** Invalidate one key. */
  invalidate(key: string): Promise<void>
  /** Invalidate all keys matching a prefix. Returns count cleared. */
  invalidatePrefix(prefix: string): Promise<number>
  /** Stats for diagnostics — hit rate, size, age distribution. Optional. */
  stats?(): Promise<CacheStats>
}

export interface CacheStats {
  hits: number
  misses: number
  size: number
  // Provider-specific extras allowed
}
```

## Provider implementations

**v1 (this design pass + scale implementation):**

- **`MemoryCache`** — `Map`-backed, per-instance, no expiry by default (TTL optional). Default for all deployments. Multi-instance-correct via per-instance independence.

**v2 (post-design-pass, demand-driven):**

- **`RedisCache`** — `ioredis` or similar; standard distributed cache pattern. Shared across all admin instances. Required for multi-instance team deployments where cache hit rate matters.
- **`AzureCache`** — Azure Cache for Redis (managed); same shape as `RedisCache` with Azure-specific connection.
- **`FileCache`** — disk-backed cache under `.gazetta/cache/`. Useful for small teams without a Redis instance who still want persistence across admin restarts.
- **`DistributedCache`** — opt-in for enterprise tier; consistent-hashing across multiple Redis nodes or similar.

**Browser-side providers** (per `design-offline.md`, foundational dimension #10):

- **`IndexedDBCache`** — large quotas (~50MB+), structured queries; default browser-side provider for offline-mode admin clients.
- **`LocalStorageCache`** — small quotas (~5MB); fallback for older browsers.

Browser-side providers are scoped to one browser tab; never shared across browsers / users / instances. They're peers to the server-side providers — implementing the same `AdminCache` interface — but coordinated independently. Server SSE invalidation events broadcast to connected browsers to invalidate their browser caches.

Operator config:

```yaml
admin:
  cache:
    type: memory                    # v1 default
    # type: redis
    # url: ${REDIS_URL}
    # type: azure
    # connectionString: ${AZURE_REDIS_CONN}
    # type: file
    # path: ./.gazetta/cache
```

## Open questions for the design pass

### Multi-instance check
- v1 `MemoryCache` is per-instance — multi-instance deployments using it have eventual consistency at the staleness window. Acceptable for read-heavy paths (`/api/pages`); confirm with concrete invalidation flows.
- Shared providers (Redis, Azure) — design pass formalizes the connection lifecycle, retry policy, fallback when provider is unreachable.
- Cache key conventions across providers — same key shape regardless of provider; consumer doesn't know the provider type. Confirmed via interface; design pass writes the conventions.

### Key conventions
- Namespace + identity: `pages:summary`, `pages:detail:{name}`, `fragments:summary`, `dependents:{asset}`. Stable across providers.
- Hashing for compound keys (e.g., locale + theme variant): SHA-256 prefix? Plain concatenation? Convention TBD.
- Reserved prefixes for internal use vs. plugin-contributed keys.

### Invalidation patterns
- Save handler → invalidate `pages:` prefix. What about `dependents:` (recompute on graph change)?
- Publish handler → invalidate target-specific keys.
- Cross-feature invalidation cascade (a fragment edit invalidates both `fragments:` AND `pages:` because pages may use the fragment) — explicit per-feature, or generic dependency-aware?

### TTL strategy
- TTL is fallback safety net per the locked invariant. Default TTL? None (cache lives until explicit invalidation)? Or 1 hour as a sanity bound?
- Per-key TTL support — required by some providers, optional in others.

### Stats / observability
- Hit-rate exposure to admin operators — toolbar widget? Logs?
- Cold-start metrics — how long does first warmup take per provider?

### Fallback behavior
- Provider unreachable (Redis down) — fail-open (read from source-of-truth) or fail-closed (return error)?
- Recommend fail-open with a logged warning. Confirm.

### Plugin-contributed cache providers
- Per `design-plugins.md`'s contract, plugins can ship `AdminCache` implementations. Design pass formalizes the registration pattern.
- Cache providers from plugins inherit multi-instance discipline of their backing store.

## Migration

Existing memo caches (e.g., `findDependentsFromSidecars` per-process memo, the existing template scan cache) migrate to `AdminCache` with `MemoryCache` provider. Behavior unchanged at v1; doors open for v2 swap.

## Future directions

**Distributed cache for enterprise.** Multi-region Gazetta deployments (e.g., admin in US + EU regions both serving the same content) need region-aware cache distribution. Consistent-hashing across Redis cluster, or per-region cache with cross-region invalidation. Tier 3 enterprise tier work.

**Cache warming hooks.** Per `design-hooks.md`, a hook lifecycle phase that fires on admin boot to pre-warm specific cache keys (e.g., the most-recently-edited 100 pages). Useful for reducing cold-start latency on cloud deployments. Reserved for after hooks ship.

**Read-through pattern.** Higher-level abstraction where consumers declare their cache key + miss-resolution function and `AdminCache` orchestrates. Reduces boilerplate at consumer sites. Could be a v2 ergonomics improvement; v1 is fine with explicit get/set.
