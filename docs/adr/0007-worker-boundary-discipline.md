# Worker boundary discipline — workers never run template code

Gazetta workers (the edge runtime serving `esi` and `dynamic` Targets — Cloudflare Workers, Deno Deploy, WinterTC-compatible runtimes) handle three responsibilities: HTTP routing, response caching, and fragment assembly via string concatenation. They do NOT execute template code. Template execution happens at publish time (Node/Bun for `static` + `island` components) or at Origin (Node/Bun server, per request, for `dynamic` Fragments).

We picked this boundary over "workers can run templates that stay in WinterTC subset" because the boundary serves the Author / Operator workflow, not just the deployment shape. Template code changes are routine — `templates/hero/index.tsx` edits happen during normal Template Developer work. With templates running at the worker, every template change requires a worker redeploy. With templates only at publish time + Origin, template changes propagate via the existing publish pipeline (`esi` re-renders affected fragments) or via Origin reading from storage at request time (`dynamic`); workers stay still.

The trade-off accepted: edge SSR with WinterTC-subset templates is reserved for v2 (when WASM-compiled templates or framework support catches up). v1 ships `dynamic` Targets as Node/Bun-only Origin. Operators who need per-request template execution at the edge wait for v2; operators who can fit their needs into static + island + ESI fragment composition get the full edge benefit (worker = pure cache + assembly = ms-level cold start, no Node runtime).

## Consequences

Worker deploys decouple from content/template lifecycle. Authors and Template Developers ship content and template changes through publish — `gazetta publish` re-renders affected fragments to storage; workers serve from storage on next request. Worker code only changes when Gazetta itself updates routing logic (rare).

Worker cache is content-addressed by design ([design-cache.md](../../.claude/rules/design-cache.md) Q1 lock): immutable hash-in-path URLs. Origin's per-request output is NOT cached by the Worker (would break per-request semantics for dynamic Fragments). Composed pages containing dynamic Fragments are not cached as a whole.

The boundary clarifies the L1-L6 cache model. L3 (Worker) does string-concatenation; never runs templates. L5 (Storage sidecars) memoize derived state across restart. L4 (Origin/Admin AdminCache) memoizes derived computations. The layers compose without overlap.

The boundary forces honest deployment options. `static` Targets need only a CDN (no worker). `esi` Targets need a WinterTC-compatible Worker. `dynamic` Targets need a Worker AND a Node/Bun Origin. Each tier's infrastructure cost matches its capability — operators choose the deployment shape that fits their content needs without paying for unused runtime.

Cross-cutting: this decision shapes `design-rendering.md` (the three Target types), `design-cache.md` (L3 + L4 split, content-addressed Worker cache), `design-plugins.md` (plugin code can register at Worker via routes but can't bypass the boundary to run templates there), `design-offline.md` (browser admin's L6 cache mirrors the L4 Origin shape via Vue Query). The `validate:edge-compatibility` validator (reserved for v2 when edge-Origin lands) checks template API surface against Target runtime — relevant only when v2 enables Origin on WinterTC.
