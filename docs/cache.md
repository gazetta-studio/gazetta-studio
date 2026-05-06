## Cache

How Gazetta caches admin reads — what the default does, when to swap
providers, and how to monitor cache health.

For the design model and `AdminCache` interface contract, see
[`.claude/rules/design-cache.md`](../.claude/rules/design-cache.md).

## What's cached

The admin server caches summary listings that are expensive to recompute
on every request:

| Surface | Cache key | Invalidated on |
|---|---|---|
| `GET /api/pages` summary | `pages:summary` | page save / delete / fragment edit / history restore |
| `GET /api/fragments` summary | `fragments:summary` | fragment save / delete / history restore |

Detail endpoints (`GET /api/pages/:name`, `GET /api/fragments/:name`)
read from disk per request — caching them adds invalidation surface
without much speedup.

## Default: `MemoryCache`

If you don't declare a cache, Gazetta uses an in-process `MemoryCache`
with these defaults:

| Knob | Default | Tunable via |
|---|---|---|
| Max entries | 10,000 | `memoryCache({ maxEntries: N })` |
| Approximate max bytes | 50 MB | `memoryCache({ maxBytes: N })` |
| Eviction | LRU on overflow | not tunable |
| TTL | none (LRU-only) | `set(..., { ttl })` accepted but ignored in v1 |

This is the right choice for single-process deployments
(`gazetta dev`, `gazetta serve`, single-container hosts). Keys live in
RAM; nothing to install.

```ts
// site.config.ts
import { defineSite, memoryCache } from 'gazetta'

export default defineSite({
  // Optional — `MemoryCache()` is the implicit default.
  cache: memoryCache({ maxEntries: 5000 }),
  // ... rest of config
})
```

## Multi-instance deployments

Each admin instance gets its own `MemoryCache` — eventual consistency
across instances is acceptable because each handles its own writes
and invalidations on its own cache. Authors editing on one instance
see fresh data on the next read against THAT instance.

If your deployment runs N admin instances behind a round-robin load
balancer (Cloud Run, Kubernetes), the cache hit rate per instance is
reduced because each warms independently. This is fine at the
documented operating envelope (~5000 pages); shared providers (Redis,
Azure Cache) reserved for v2 when concrete operator demand surfaces.

## Per-site key isolation

Every cache instance is wrapped per-site — keys transparently get a
`site:{name}:` prefix before reaching the underlying provider. Two
sites sharing a backing service (future Redis cluster) don't collide
on `pages:summary`.

You don't write the prefix yourself; the wrapping happens at admin
boot. Plugin authors writing custom providers see only the wrapped
keys.

## Monitoring

### On-demand snapshot

```
GET /api/system/cache/stats
```

Returns the current cache stats for the resolved source. Honors
`?target=...` like every other admin route — different targets have
different caches.

```json
{
  "hits": 142,
  "misses": 17,
  "size": 8,
  "evictions": 0,
  "bytesApproximate": 1834,
  "lastInvalidation": {
    "prefix": "pages:",
    "at": "2026-05-06T11:42:00.000Z",
    "source": "local"
  }
}
```

`hits` / `misses` / `size` are guaranteed by the contract. Optional
fields surface when the underlying provider tracks them.

### Periodic structured log

The admin process emits a structured log entry every 5 minutes:

```json
{
  "timestamp": "2026-05-06T11:45:00.000Z",
  "level": "info",
  "module": "cache.stats",
  "message": "cache stats",
  "stats": { "hits": 142, "misses": 17, "size": 8, ... }
}
```

Pipe stdout to your log aggregator (Datadog, Loki, journalctl) and
filter on `module:cache.stats`. Cadence isn't tunable; operators with
stricter monitoring polls `/api/system/cache/stats` directly.

To suppress the periodic log entirely (e.g., in development), pass
`disableCacheStatsLogger: true` to `createAdminApp()`. The stats
endpoint still works.

## Plugin-contributed providers

Per [`design-cache.md`](../.claude/rules/design-cache.md) plugin-promotion
rules, providers like Redis and Azure Cache will ship in-tree when
3+ operators ask. Until then, plugin authors export a factory that
returns an `AdminCache`:

```ts
// In @example/redis-cache
import type { AdminCache } from 'gazetta'

export function redisCache(opts: { url: string }): AdminCache {
  // ... build a provider satisfying AdminCache
}
```

Operators import and invoke directly:

```ts
import { defineSite } from 'gazetta'
import { redisCache } from '@example/redis-cache'

export default defineSite({
  cache: redisCache({ url: process.env.REDIS_URL! }),
})
```

### Validating a custom provider

Plugin authors run the contract test helper to confirm baseline LSP
correctness:

```ts
// In your provider's test suite
import { describe } from 'vitest'
import { adminCacheContractTests } from 'gazetta/testing'
import { redisCache } from '../src'

describe('redisCache satisfies the AdminCache contract', () => {
  adminCacheContractTests(
    () => redisCache({ url: 'redis://localhost:6379/15' }),
    {
      supportsTtl: true,
      supportsCrossInstanceSubscribe: true,
      supportsTransportFailureSimulation: true,
    },
  )
})
```

The capability flags gate the optional test blocks. Providers that
don't honor TTL leave `supportsTtl` false; the suite skips the TTL
test cleanly.

## Cached values must be JSON-serializable

The `AdminCache` contract requires JSON-serializable values — no
functions, no Symbols, no top-level Maps or Sets. This holds across
all providers (in-process and shared) so that future browser-side
caches (`IndexedDBCache`, etc.) can persist the same entries from the
same consumer code.

If you're caching something that isn't naturally serializable, do the
serialization in the consumer.
