# AI Integration

How the CMS integrates AI capabilities — alt-text generation in v1.5, with translation, summarization, and tag suggestion as anticipated future tasks. Designed as a layered abstraction so each new task adds to a shared infrastructure rather than reimplementing it.

**This doc covers the design:** layered architecture, configuration model, alt-text task in detail, refusal handling, image preprocessing, prompt composition, runtime model, security, and distinctive choices.

**Companion docs:**
- [design-ai-implementation.md](design-ai-implementation.md) — v1.5 commit sequence, scope, deferred items, migration path.

## Scope

**In v1.5:**
- Alt-text generation as the first AI task
- Three providers: Anthropic Claude, OpenAI gpt-4o, Ollama llama3.2-vision (self-hosted)
- Per-task config blocks under `site.config.ts` (`altText:`)
- Cross-task `ai:` block for shared concerns (`provider`, `defaultModel`)
- Process-level credentials via `.env.local` (no per-target API keys)
- Auto-fill on upload (default) + on-demand from detail pane
- Structured refusal detection (provider says no → don't auto-fill, show reason)
- Direct multilingual generation (model writes in target locale; no separate translation pass)
- Per-target overrides for behavior (`auto`, etc.); never for credentials/provider

**Out of v1.5 (explicit):**
- Translation task (designed for; not implemented)
- Tag suggestion, summarization, image generation
- Per-target adapter override (process-level adapter only in v1.5)
- Distributed cache for suggestions (suggester is stateless; multi-replica correct)
- Confidence scoring (the field doesn't exist on the contract)
- Cost monitoring / budget caps
- Admin-side rate-limit throttling (provider SDKs handle their own backoff)
- AI safety/content moderation (provider's own policies apply; we surface refusals structurally)

**Non-goals:**
- Replacing author judgment. AI alt is a suggestion the author can accept, edit, or clear. The author is always the final word.
- Provider-specific quality optimization. We ship neutral prompts that work across Claude, gpt-4o, and llama3.2-vision. Operators tune `model` per task if they want a specific provider's strengths.

## Architecture: three orthogonal layers

AI in Gazetta is **three concerns at three lifetimes**, each with its own home:

| Layer | What it owns | Where it lives | Lifetime |
|---|---|---|---|
| **Provider account** | API keys, base URLs | `.env.local` | Process |
| **Task configuration** | Per-task model, behavior flags, sizing | `site.config.ts` (per-task blocks, `ai:` for shared) | Site lifetime |
| **Cross-task infrastructure** | Refusal detection, prompt composition, vision preprocessing | Code modules under `packages/gazetta/src/ai/` | Code, not config |

These layers don't bleed into each other. Credentials never appear in `site.config.ts`. Cross-task code never reads config directly — it operates on resolved literal arguments. Per-task config never references env vars; the factory wires the layers together.

### Why three layers, not one big config block

Earlier drafts of this design merged all AI config into one `ai:` block. That bundled cross-task concerns (provider) with task-specific concerns (`maxImageEdge` only applies to vision tasks; `auto` only applies to alt-text). Splitting at the right SOLID seams:

- **Cross-task fields** in `ai:` — fields that ALL AI tasks legitimately use (provider, default model)
- **Task-specific fields** in per-task blocks — fields that only one task uses (`auto` for alt; future `translateOnPublish` for translation)
- **Vision-specific fields** stay on vision-using task blocks — `maxImageEdge` is on `altText:`, would also be on a future tag-suggestion task that processes images, never on `translation:`

This avoids inventing a "vision tasks" sub-grouping (ISP violation — would mean some tasks implement an interface they don't fully use).

## Configuration model

### Env (`.env.local`)

Process-level credentials only. Gitignored. Never in `site.config.ts`.

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
# OLLAMA_BASE_URL=http://localhost:11434  (optional; default shown)
```

If a provider's adapter is selected but its key is missing, `isAltAdapterConfigured(target)` returns false, the UI hides AI affordances, and any direct route call returns `503 alt_adapter_unavailable` with a structured error. No throw at admin boot — process starts always; per-task features fail at first invocation, where the failure is in context.

### Site-level (`site.config.ts` top-level)

Two blocks: `ai:` for cross-task, `altText:` for the v1.5 task.

```ts
import { defineSite } from 'gazetta'

export default defineSite({
  name: 'main',
  defaultLocale: 'en',

  ai: {
    provider: 'anthropic',              // one of: anthropic, openai, ollama
    defaultModel: 'claude-haiku-4-5',   // falls back to per-provider sensible default if unset
  },

  altText: {
    // provider: <inherits ai.provider>
    // model: <inherits ai.defaultModel>
    auto: true,                         // default; auto-fire suggest on upload
    maxImageEdge: 768,                  // default; vision-call sizing
  },

  // Future:
  // translation: {
  //   model: 'claude-sonnet-4-5',      // override defaultModel for translation quality
  //   translateOnPublish: false,
  // },
})
```

**Field inheritance:** task block resolves left-to-right against `target → site task block → site ai block → hardcoded default`. First defined wins. The `resolveAltConfig(site, target, base)` function is the single source of truth for the merge.

**Provider can be overridden per task** (e.g., `altText.provider: 'ollama'` while `ai.provider: 'anthropic'`). v1.5 doesn't expose this in any UI, but the config model accepts it — when a future operator needs Anthropic for translation and Ollama for alt-text in one site, no schema migration is required.

### Target-level (`site.config.ts` per target)

Per-task **behavior** overrides only. Never provider, never credentials.

```ts
export default defineSite({
  targets: {
    local: {
      storage: { type: 'filesystem' },
      // inherits everything from site
    },
    production: {
      storage: { type: 'r2' /* ... */ },
      altText: {
        auto: false,                    // review-first on prod
      },
    },
  },
})
```

**Why behavior-only at target level:** provider/credentials are operationally global. An operator with one Anthropic account uses it for staging and prod alike. Per-target provider-switching is theoretically possible (the schema permits it for forward-compatibility) but not a v1.5 feature.

### The capability flag the UI sees

The `/api/targets` endpoint returns `TargetInfo.altText: { available, auto }` per target. The UI renders affordances based on this resolved capability — not on raw config.

```ts
interface AltTextCapability {
  available: boolean    // resolved adapter exists + credentials present
  auto: boolean         // resolved auto flag (post-merge)
}

interface TargetInfo {
  // ... existing fields
  altText: AltTextCapability
}
```

`available` is a process-global truth in v1.5 (one adapter for the admin). It varies per-target only when target-level provider override lands in a future version. The shape is right for now; expansion is additive.

## Code organization

```
packages/gazetta/src/
  ai/                              # cross-task infrastructure
    refusal.ts                     # refusal detection — provider patterns
    compose-prompt.ts              # prompt assembly from typed AltRequest
    prompt-policies.ts             # per-dimension prompt-policy modules
    vision-prep.ts                 # sharp-based resize-to-768 for vision calls
    provider.ts                    # AIProvider type + ResolvedAIBase + resolveAIBase
    errors.ts                      # AI-specific error taxonomy
  alt/                             # alt-text task
    adapter.ts                     # AltTextAdapter interface + AltSuggestion type
    suggester.ts                   # AltSuggester orchestration (cancellation, errors, events)
    null-adapter.ts                # safe default; supports() = false everywhere
    anthropic.ts                   # provider impl
    openai.ts
    ollama.ts
    config.ts                      # ResolvedAltConfig + resolveAltConfig
    index.ts                       # buildAltAdapter factory
```

**`ai/` is a code library, not an inheritance hierarchy.** Tasks compose `ai/` utilities; they don't extend a base class. `alt/` imports `ai/refusal.ts`, `ai/compose-prompt.ts`, `ai/vision-prep.ts`. A future `translate/` directory will import `ai/refusal.ts`, `ai/compose-prompt.ts` (different policies, same composer), and contribute its own task-specific code.

This is composition over inheritance from the start, per [team-preferences.md](team-preferences.md): "Prefer composition over inheritance — use static helpers or injected services, not base classes."

## Alt-text task

### The contract

```ts
// alt/adapter.ts
export interface AltTextAdapter {
  readonly name: string
  /** True when the adapter can describe this MIME (images-only in v1.5). */
  supports(mime: string): boolean
  /** Returns suggestion + structured refusal info; throws on transport / API failure. */
  generate(input: AltGenerateInput, signal?: AbortSignal): Promise<AltSuggestion>
}

export interface AltGenerateInput {
  bytes: Uint8Array
  mime: string
  request: AltRequest               // structured params (locale, maxChars, style)
  prompt: string                    // composed prompt for adapters that inject a string
}

export interface AltRequest {
  locale: string                    // 'en', 'fr', etc. — direct generation, not translate
  maxChars: number                  // 125 default per WAI-ARIA convention
  style: AltStyle
}

export type AltStyle = 'descriptive'  // closed enum; future: 'marketing', 'technical'

export interface AltSuggestion {
  text: string
  /** True when the model declined or couldn't describe the image. */
  refused: boolean
  /** Human-readable reason when refused; null otherwise. */
  refusalReason: string | null
}
```

**No `confidence` field.** Considered and rejected — providers don't expose calibrated confidence for free-form generation; a hardcoded null would be a stub-on-the-interface (LSP violation per [team-preferences.md rule 18](team-preferences.md)). Refusal is the structured signal that earns its place.

**`AltGenerateInput` carries both structured request AND composed prompt.** Adapters that have native parameters (Anthropic's `max_tokens` derivable from `request.maxChars`) use the structured form; adapters that just need a prompt string use the composed form. Both are computed once by the suggester; adapters consume what suits them.

### The orchestration layer

```ts
// alt/suggester.ts
export interface AltSuggester {
  /** True when adapter is configured AND adapter.supports(mime) is true. */
  available(mime: string): boolean
  /** Returns structured suggestion or null when call couldn't complete. */
  suggest(input: SuggestInput, signal?: AbortSignal): Promise<AltSuggestion | null>
}

export interface SuggestInput {
  bytes: Uint8Array
  mime: string
  hash: string                      // identifies asset; used for diagnostics, not cache
  locale: string
  /** When the source is animated, callers pass the analyzer's first-frame poster. */
  posterBytes?: Uint8Array
}
```

The suggester:
- Builds the typed `AltRequest` from inputs + defaults.
- Composes the prompt via `composePrompt(request, policies)`.
- Calls `prepareForVision(bytes, posterBytes, mime, maxImageEdge)` to resize before the adapter call.
- Forwards `AbortSignal` to the adapter.
- Catches transport errors → returns null + emits structured event for UI toast.
- Returns the adapter's `AltSuggestion` directly (including `refused`).

**Stateless** — no memoization. Multi-replica admin scales horizontally without divergent caches. If memoization later proves operationally necessary, it lands as a `CachedAltSuggester` decorator wrapping the base — additive, multi-replica-correct via shared storage. The contract stays cache-free.

### Why no cache

Considered: per-replica `Map<(hash, locale), Promise<AltSuggestion>>` to avoid re-billing for the same image across an auto-suggest + on-demand-click pair. Rejected because:

1. **Multi-replica admin is a documented constraint** ([design-media-implementation.md](design-media-implementation.md) explicitly rejected in-memory designs for the asset-refs index for the same reason).
2. **Real hit rate is low.** Auto-suggest + immediate-click is rare. Auto-suggest + days-later-click is common, but admin processes restart between sessions — a per-replica cache wouldn't help anyway.
3. **The orchestration responsibilities that DO belong on the suggester** (cancellation, error handling, refusal events) don't depend on caching. Removing caching doesn't impair the abstraction; it makes it leaner.

When caching genuinely earns its keep (operationally measured, not speculatively designed), the decorator pattern lands additively.

### Refusal detection

Lives at `ai/refusal.ts` because it's cross-task: a translation refusal looks the same as an alt-text refusal (provider says "I can't comply" via 200 OK with refusal text in the content field).

```ts
// ai/refusal.ts
const SHARED_REFUSAL_MARKERS = [
  "i can't describe",
  "i'm not able to describe",
  "i cannot describe",
  "i'm unable to provide",
  // ... maintained list of cross-provider refusal phrases
]

export function detectRefusal(
  text: string,
  adapterMarkers: readonly string[] = [],
): { refused: boolean; reason: string | null } {
  const lower = text.toLowerCase()
  const allMarkers = [...SHARED_REFUSAL_MARKERS, ...adapterMarkers]
  for (const marker of allMarkers) {
    if (lower.includes(marker)) {
      return { refused: true, reason: text.slice(0, 200) }
    }
  }
  if (text.trim().length < 5) {
    return { refused: true, reason: 'Empty or unusably short response' }
  }
  return { refused: false, reason: null }
}
```

Each adapter calls `detectRefusal(rawText, ANTHROPIC_SPECIFIC_MARKERS)` (or its provider's equivalent) and constructs the `AltSuggestion` with structured fields. The UI consumes the structured signal directly — never inspects `text` for refusal substrings (DIP violation prevented).

### Vision preprocessing

```ts
// ai/vision-prep.ts
export interface PreparedImage {
  bytes: Uint8Array
  mime: string                      // 'image/jpeg' | 'image/png' (post-prep)
}

export async function prepareForVision(input: {
  bytes: Uint8Array
  mime: string
  posterBytes?: Uint8Array          // animated-image first-frame, when applicable
  maxEdge?: number                  // default 768
}): Promise<PreparedImage>
```

**Default 768 max edge.** Smallest size that fits all three v1.5 providers natively without quality loss:

| Provider | Native input | At 768 |
|---|---|---|
| Ollama llama3.2-vision | 1120×1120 | Fits, no downsample |
| Anthropic Claude (non-Opus) | 1568px long edge | ~786 tokens (well under 1568 ceiling) |
| OpenAI gpt-4o (high detail) | 768 short-edge target | Exactly 4 tiles + base = 765 tokens |

768 is also where OpenAI's high-detail mode targets the short edge — chosen by OpenAI because it's where text in images remains legible for their model. Below 768 starts trading documented quality for cost.

**`maxImageEdge` is per-task** because vision tasks may want different sizes (a future tag-suggestion task on detailed product shots might want 1024). Default 768; per-task site-level override; per-target task-level override.

**Animated images use the analyzer-extracted poster.** The animated-image analyzer (shipped in media v1 step 31) already extracts a first-frame PNG poster. The suggester passes those bytes to `prepareForVision` instead of re-rasterizing. Cross-feature reuse, no duplication.

**SVG rasterizes to PNG** at MAX_EDGE before the vision call (sharp via SVG renderer at 144 dpi). OpenAI doesn't accept SVG natively; uniform handling beats per-adapter SVG fallback.

**Skip resize when source ≤ MAX_EDGE.** No re-encode; original bytes pass through.

### Prompt composition

The prompt is **policy**, not a string. Composing it from typed dimensions per [team-preferences.md rule 18](team-preferences.md) ("build structurally right from the start").

```ts
// ai/prompt-policies.ts — each policy contributes one paragraph
export function taskFramingPolicy(req: AltRequest): string
export function styleGuidancePolicy(req: AltRequest): string
export function lengthPolicy(req: AltRequest): string
export function localePolicy(req: AltRequest): string
export function outputDisciplinePolicy(req: AltRequest): string

// ai/compose-prompt.ts
export type PromptPolicy = (req: AltRequest) => string

export function composePrompt(
  req: AltRequest,
  policies: readonly PromptPolicy[] = DEFAULT_POLICIES,
): string
```

**Why typed policies, not a single string constant:**
- SRP: each policy changes for one reason. Locale strategy change → `localePolicy` only. WCAG guidance update → `styleGuidancePolicy` only.
- OCP: new style (e.g., `'marketing'`, `'technical'`) extends the `AltStyle` enum + adds a switch arm. Other policies untouched.
- Testability: each policy unit-tests independently; the composer tests assembly.

**Locale-aware generation, not translation.** `localePolicy` adds "Write the description in {locale}." when locale ≠ 'en'. Modern vision models are competently multilingual. Translation as a separate pipeline (vision → English → translate) was rejected: more API calls, translation artifacts (e.g., translating UI text like button labels that should stay in source language), and a parallel `TranslationAdapter` system before its second consumer exists.

If Ollama's non-English quality proves insufficient in real use, an opt-in `translateFrom: 'en'` per-task field activates a translation pipeline. Additive; no v1.5 design cost.

## Provider adapters

### What each adapter owns

- Provider SDK construction (with literal `apiKey` from factory)
- Request shape: convert `AltGenerateInput` → provider-specific request body
- Response parsing: extract text from provider response shape
- Refusal detection: call `detectRefusal` with provider-specific markers
- AbortSignal forwarding
- Provider-specific error → `AltAdapterError` translation

### What no adapter owns

- Reading env vars (factory does this)
- Image preprocessing (`vision-prep.ts` does this)
- Prompt composition (`compose-prompt.ts` does this)
- Memoization (the suggester is stateless; no memoization in v1.5)
- UI concerns (consumers handle errors and refusals)

### Three providers in v1.5

| Provider | API | Auth | Model default | Why ship |
|---|---|---|---|---|
| **Anthropic** | `messages.create` with image content block | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | Aligned with the codebase's tooling; well-priced; multilingually competent |
| **OpenAI** | `chat.completions` with `image_url` (base64 data URL) | `OPENAI_API_KEY` | `gpt-4o-mini` | Wide adoption; cheapest paid SaaS; required for substitution proof |
| **Ollama** | HTTP to `/api/generate` (or `/api/chat`) | None (local) | `llama3.2-vision` | Self-hosted; zero-cost; bytes never leave operator infra; required for self-hosted parity |

Three providers prove the abstraction holds (one paid, one paid alternative, one self-hosted). Future adapters (Gemini, Cloudflare Workers AI) land additively.

### Why three, not one

If only Anthropic shipped, we'd be guessing whether the interface generalizes. Two adapters force real generalization (auth shape, request shape, response parsing, error taxonomy). Three confirms — and importantly, gives self-hosted operators a path that doesn't depend on cloud SaaS.

## Runtime model

### When AI runs

| Trigger | Where | Decision |
|---|---|---|
| Asset uploaded, `auto: true`, target has adapter, MIME supported | `AssetUploadZone.vue` upload-list row | Auto-fire `POST /api/assets/:name/suggest-alt` after upload completes |
| Author clicks "✨ Suggest" in detail pane | `AssetAltEditor.vue` | Fire suggest call on demand, regardless of `auto` |
| Author types into alt input while suggest is in flight | `AssetUploadZone.vue` row | Abort the suggest call; author intent wins |

**Auto-suggest is post-upload, client-driven, one extra HTTP round-trip.** Folding the AI call into the upload pipeline (server-side at upload time) was rejected: AI failure would fail the upload itself; latency on bulk uploads stacks unacceptably; SRP violation in `ingest.ts`.

### The route

```
POST /api/assets/:name/suggest-alt?target=&locale=
→ 200 { text: "...", refused: false, refusalReason: null }
→ 200 { text: "I can't describe this image.", refused: true, refusalReason: "..." }
→ 503 { code: 'alt_adapter_unavailable' }
→ 502 { code: 'alt_suggestion_failed' }
→ 404 { code: 'asset_not_found' }
→ 400 { code: 'invalid_request' }
```

**Refusal returns 200 with `refused: true`.** The API call succeeded; the model declined. This matches the existing pattern (`POST /api/publish` returns 200 with `{ ok: false, errors }` when content validation fails). HTTP status reflects API success/failure; body fields reflect domain results.

**Server fetches bytes from storage.** Upload-list row passes `name`; server reads bytes via the existing storage abstraction. Doesn't accept fresh bytes in the POST body — that would either duplicate the upload route's contract or split the surface (one route accepting name, another accepting bytes; ISP violation). The "saved storage read" optimization is sub-perceptible (~50ms hot cache hit for fresh writes).

### How the UI knows

`/api/targets` reports `TargetInfo.altText: { available, auto }` per target. The UI reads this on admin load and on `site.config.ts` reload (existing SSE infrastructure). No probe-by-failure; no separate capability endpoint.

```vue
<!-- AssetUploadZone.vue (excerpt) -->
<script setup>
async function onUploadComplete(result) {
  if (activeTarget.value.altText.available && activeTarget.value.altText.auto) {
    fireSuggestAlt(result.name)  // background, non-blocking
  }
}
</script>

<!-- AssetAltEditor.vue (excerpt) -->
<Button v-if="activeTarget.altText.available" @click="suggest">
  ✨ Suggest
</Button>
```

## Security

### Provider trust boundary

Bytes leave the admin process when the suggester calls a SaaS adapter. Operators choosing Anthropic/OpenAI accept that asset bytes are sent to those providers' servers, subject to those providers' data-handling policies. Ollama operators keep bytes local.

**Documented prominently** in `docs/content-assets.md` (AI alt section): "When using Anthropic or OpenAI, asset bytes are sent to the provider for description. Use Ollama for self-hosted privacy."

### Content moderation

We do **not** add a moderation layer. Provider safety policies apply (Claude refuses certain content; gpt-4o has its own categories; Ollama has minimal filtering). Refusals surface structurally so authors see why their image wasn't described. We don't second-guess provider decisions.

### API key exposure

Keys live in `.env.local` (gitignored, per [operations.md](operations.md)). Adapter modules read `process.env.X_API_KEY` at construction. Never logged. Never returned in API responses. Never in `site.config.ts`.

If a key is missing for a configured provider, `isAltAdapterConfigured(target)` returns false at the capability check; the route returns `503 alt_adapter_unavailable`; the UI hides affordances. No leak path.

### Prompt injection

User-uploaded images could theoretically contain text that influences the model's response. The current prompt structure (model receives image + instruction) makes prompt-injection-via-image hard but not impossible. Mitigations:

- The composed prompt is explicit about the task ("Output the description only, no preamble or quotes") which the model treats as system-level guidance.
- Refusal detection catches "I won't follow these new instructions" responses.
- The output is alt text shown to the author for review (unless `auto: true` AND no refusal, in which case it pre-fills the input — author can still edit before save).

For sites uploading user-generated content (future use case), authors should review AI-suggested alt before publish. The `altText.auto: false` flag puts review-first mode in operator control.

## Distinctive choices

### Compared to other CMSes

- **Strapi Growth** — built-in AI alt, but coupled to Strapi's specific deployment model. Gazetta's adapter abstraction is provider-agnostic and admin-process-local.
- **Storyblok** — AI alt as a paid add-on. Gazetta ships in v1.5, no upsell.
- **Directus 11.16** — three-provider adapter pattern (similar architectural choice). Gazetta's pattern is similar but explicitly cross-task-ready (the `ai:` block + `ai/` infrastructure code anticipates translation, summarization, etc.).
- **Sanity / Contentful / Payload** — no shipped AI alt as of design time. Operators wire their own integrations.

### Architectural choices

**Per-task config blocks, not a single AI block.** Each AI capability has its own concerns; bundling them creates SRP violations. The shared `ai:` block carries only truly cross-task fields (`provider`, `defaultModel`).

**Cross-task code under `ai/` from the start.** Not after the second consumer materializes. Refusal detection, prompt composition, vision preprocessing are conceptually cross-task even with one consumer in v1.5. Right structure now beats right structure later, because translation is on the documented roadmap.

**Stateless suggester (no memoization).** Multi-replica admin correctness over per-replica optimization. Caching is a future decorator, additive.

**Direct multilingual generation, not translation pipeline.** Lower latency, lower cost, better idiomatic output, and avoids designing a `TranslationAdapter` system before its second consumer exists.

**Refusal as structured signal, not confidence number.** The honest categorical: did the model decline? Not a fake graduated score. Consumers branch on `refused`, not `confidence < threshold`.

**Process-level credentials, target-level behavior.** Reflects operational reality: one operator, one set of API accounts; per-target workflow differs (`auto: false` on prod, default on staging).

## Migration

### Existing sites

`site.config.ts` files without `ai:` or `altText:` blocks continue to work — AI alt is a v1.5 feature behind explicit config. Operators opt in by adding the blocks.

### Existing assets

The detail-pane "✨ Suggest" button works on assets uploaded before AI alt was configured. Backfill is per-asset, on-demand. No bulk-suggest in v1.5; deferred to a CLI command (`gazetta assets suggest-alt --all`) when the use case surfaces.

### Provider switching

Changing `ai.provider` from `anthropic` to `openai` requires:
- Updating `.env.local` to provide the new credentials
- Restarting the admin process (config is read at boot for env, at first use for adapter)

No data migration. Existing alt text on assets is unchanged. New suggestions come from the new provider.
