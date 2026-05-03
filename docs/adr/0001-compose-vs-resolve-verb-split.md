# Compose vs. Resolve: separate verbs for tree-walking and value-picking

The codebase had `resolveComponent`, `resolveAssetRefs`, `resolveLocaleFallback`, `resolveAltConfig`, `resolveSeoTags`, `resolveEnvVars`, and roughly a dozen more `resolve*` functions. Reading the code, "resolve" was doing three structurally different jobs: (1) walk a tree and replace references with loaded contents, (2) pick a value from a fallback chain, (3) merge layered config into a single value. We split the vocabulary: **Compose** for the tree-walking operation; **Resolve** for chain-picks and config-merges.

## Considered options

We considered renaming all `resolve*` code to `compose*` where appropriate (Option A), keeping everything as `resolve*` and disambiguating only in conversation (Option C), and a slimmer middle (Option B — only rename config-merge functions). We picked C: existing code keeps `resolve*` for stability; conversation, new code, and new docs use Compose for tree-walking. Renaming the codebase is a multi-day mechanical refactor with no runtime benefit; the cognitive cost lives mostly in conversation, which a glossary fixes.

## Consequences

New code that walks trees and replaces references should be named `compose*`, not `resolve*`. The output of composition is a Resolved Component / Resolved Page / Resolved Asset Reference (the past participle is naturally "resolved" because the structure is settled). This may read inconsistently for a future reader unfamiliar with the split — the glossary entry in `CONTEXT.md` is the canonical reference.
