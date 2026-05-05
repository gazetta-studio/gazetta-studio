# AI Integration — Implementation

Companion to [design-ai.md](design-ai.md). This doc covers what we're doing with the design: v1.5 commit sequence with risk ordering, scope per commit, deferred items, open implementation questions, and migration considerations.

See [design-ai.md](design-ai.md) for the design itself.

## v1.5 commit sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `ai-alt-v1.5` off `main`. Commits ordered low-risk-first per [team-preferences.md rule 17](team-preferences.md): "Build and validate, don't spike. Each commit must produce real code that stays if the approach works, be independently rollback-able, validate the riskiest assumptions early."

### Commit sequence

| # | Commit | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | AI infrastructure: refusal + vision-prep + prompt policies | ✓ | Low | Pure functions; no external dependencies |
| 2 | AltTextAdapter + null adapter + AltSuggester contract | ✓ | Low-medium | The seam everything else hangs off |
| 3 | Anthropic adapter + msw tests | ✓ | Medium-high | First real provider integration; proves adapter contract |
| 4 | OpenAI adapter + msw tests | ✓ | Low | Substitution proof; second provider |
| 5 | Ollama adapter + msw tests | ✓ | Low | Self-hosted parity; third provider |
| 6 | Site/target config types + `ai:` block schema + resolvers + factory | ✓ | Medium | Config layering correctness |
| 7 | `POST /api/assets/:name/suggest-alt` route + `/api/targets` capability | ✓ | Medium | Admin API integration |
| 8 | UI: upload-list auto-fill + detail-pane "✨ Suggest" | ✓ | Medium | The visible feature |
| 9 | Docs (`docs/content-assets.md` AI alt section + `site.config.ts` examples) + plan update | ✓ | Low | User-facing documentation |

### Per-commit scope

#### Commit 1: AI infrastructure

**Files added:**
- `packages/gazetta/src/ai/refusal.ts` — `detectRefusal(text, adapterMarkers)` + shared marker list
- `packages/gazetta/src/ai/vision-prep.ts` — `prepareForVision(input)` with sharp resize-to-768
- `packages/gazetta/src/ai/prompt-policies.ts` — five policy functions (taskFraming, styleGuidance, length, locale, outputDiscipline)
- `packages/gazetta/src/ai/compose-prompt.ts` — `composePrompt(req, policies)`
- `packages/gazetta/src/ai/provider.ts` — `AIProvider` type
- `packages/gazetta/src/ai/errors.ts` — `AltAdapterError` + variants
- Test files for each

**Tests:**
- `tests/ai-refusal.test.ts` — shared markers + adapter-specific markers + empty-response case
- `tests/ai-vision-prep.test.ts` — JPEG/PNG/SVG paths + skip-if-small + animated poster
- `tests/ai-compose-prompt.test.ts` — default policies + custom policy injection + empty-string drop-out
- `tests/ai-prompt-policies.test.ts` — each policy in isolation + locale ≠ 'en' branch

**No consumers yet.** Pure utility ship.

**Why first:** Lowest blast radius. If the design of any of these is wrong, only the file being wrong reverts. No upstream coupling.

#### Commit 2: AltTextAdapter + null adapter + AltSuggester contract

**Files added:**
- `packages/gazetta/src/alt/adapter.ts` — `AltTextAdapter` interface, `AltSuggestion`, `AltGenerateInput`, `AltRequest`, `AltStyle`
- `packages/gazetta/src/alt/null-adapter.ts` — `nullAltAdapter` with `supports()` always false
- `packages/gazetta/src/alt/suggester.ts` — `AltSuggester` interface + `createAltSuggester({ adapter })`

**Tests:**
- `tests/alt-suggester.test.ts` — orchestration: AbortSignal forwarding, error → null + event, refusal pass-through, vision-prep called once, prompt composed once
- `tests/alt-null-adapter.test.ts` — supports always false; LSP check

**Why second:** Defines the seam. With three providers landing in commits 3-5, the contract has to be right first. Null adapter is the LSP test seam — proves substitution works before any real adapter ships.

**Risk:** the contract may need to flex when commit 3 hits a real SDK. If that happens, amend commit 2 before pushing 3 (or land a 2.5 if 2 is already on the remote).

#### Commit 3: Anthropic adapter

**Files added:**
- `packages/gazetta/src/alt/anthropic.ts` — `createAnthropicAltAdapter({ apiKey, model })` using `@anthropic-ai/sdk`
- `package.json` — add `@anthropic-ai/sdk` dependency
- Anthropic-specific refusal markers in the adapter file

**Tests:**
- `tests/alt-anthropic.test.ts` — msw-mocked happy path, refusal detection, error → typed error, AbortSignal cancellation, model parameter usage, image base64 encoding correctness

**Why now:** First real integration. If the SDK's request/response shape doesn't fit `AltGenerateInput`/`AltSuggestion`, this is where we find out. With only the contract layer above us (commits 1-2), revert is cheap.

**Risk:** highest in the sequence. Anthropic SDK quirks (rate limit error shapes, vision content format edge cases) surface here.

#### Commit 4: OpenAI adapter

**Files added:**
- `packages/gazetta/src/alt/openai.ts` — `createOpenAIAltAdapter({ apiKey, model })` using `openai` SDK
- `package.json` — add `openai` dependency
- OpenAI-specific refusal markers

**Tests:**
- `tests/alt-openai.test.ts` — same shape as Anthropic tests; provider-specific request/response shape

**Why now:** Substitution proof. The interface from commit 2 has been validated against one provider; this confirms it generalizes. If the interface needs adjustment to fit OpenAI, that's evidence the design from commit 2 was wrong — fix at commit 2 (or 2.5).

#### Commit 5: Ollama adapter

**Files added:**
- `packages/gazetta/src/alt/ollama.ts` — `createOllamaAltAdapter({ baseUrl, model })` using fetch (no SDK)
- Ollama-specific refusal markers

**Tests:**
- `tests/alt-ollama.test.ts` — msw-mocked happy path, refusal detection, connection-refused error, AbortSignal, base64 encoding

**Why now:** Self-hosted path. Different from the SaaS adapters in that it's HTTP-against-localhost without an SDK. If the interface fits Ollama too, the abstraction is solid across the v1.5 set.

**No SDK dependency.** Ollama's JS SDK exists but adds little value over `fetch` for our use case (single endpoint, no auth, no streaming).

#### Commit 6: Site/target config + resolvers + factory

**Files added/modified:**
- `packages/gazetta/src/types.ts` — `AIConfig`, `AltTextConfig` (site + target), `SiteConfig.ai`, `SiteConfig.altText`, `TargetConfig.altText`
- `packages/gazetta/src/ai/provider.ts` — extend with `ResolvedAIBase` + `resolveAIBase(site)`
- `packages/gazetta/src/alt/config.ts` — `ResolvedAltConfig` + `resolveAltConfig(site, target, base)`
- `packages/gazetta/src/alt/index.ts` — `buildAltAdapter(target)` factory + `isAltAdapterConfigured(target)`

**Tests:**
- `tests/alt-config-resolver.test.ts` — inheritance (target > site > base > hardcoded default) + provider must come from somewhere + null-when-nothing-configured
- `tests/alt-factory.test.ts` — provider selection + missing API key → throws + null factory output when unconfigured + each provider construction path

**Why now:** Adapters exist; config now wires them up. Factory is the single seam between config layers and adapters. No HTTP yet.

**Validates:** the three-layer config decomposition (env / site `ai:` / per-task) actually composes correctly.

#### Commit 7: Admin API integration

**Files added/modified:**
- `packages/gazetta/src/admin-api/routes/suggest-alt.ts` — the route
- `packages/gazetta/src/admin-api/routes/targets.ts` — extend with `altText: { available, auto }` per target
- `packages/gazetta/src/admin-api/schemas/assets.ts` — `SuggestAltResponseSchema`
- `packages/gazetta/src/admin-api/schemas/targets.ts` — extend `TargetInfoSchema` with `altText`
- `packages/gazetta/src/admin-api/error-response.ts` — handle `AltAdapterError` variants
- Wire route into the admin-api `Hono` app

**Tests:**
- `tests/admin-api-suggest-alt.test.ts` — happy path, refusal pass-through, 503 unavailable, 502 adapter-failed, 404 missing asset, locale parameter, target parameter
- `tests/admin-api-targets-alttext.test.ts` — capability flag presence, available true/false based on env

**Why now:** Server-side feature is complete after this commit — a manual `curl` proves end-to-end works without any UI.

#### Commit 8: UI integration

**Files modified:**
- `apps/admin/src/client/api/assets.ts` — add `suggestAlt(name, target, locale)` API call
- `apps/admin/src/client/components/AssetUploadZone.vue` — auto-fire on upload when `auto: true`; AbortSignal on user typing
- `apps/admin/src/client/components/AssetAltEditor.vue` — "✨ Suggest" button visible when `available`
- Loading indicator during in-flight suggest; refusal toast component
- `apps/admin/src/client/stores/activeTarget.ts` — expose `altText` capability

**Tests:**
- `apps/admin/tests/AssetUploadZone.test.ts` — auto-fire on `auto: true`, no fire on `auto: false`, abort on user typing, refusal shown as toast
- `apps/admin/tests/AssetAltEditor.test.ts` — button hidden when `available: false`, click triggers suggest, refusal shown inline

**Why last:** Visible feature. Full-stack working before authors see it. If any layer is wrong, lower commits revert without UI thrash.

#### Commit 9: Docs + plan

**Files added/modified:**
- `docs/content-assets.md` — new "AI alt text" section: configuration, provider choice, privacy considerations, refusal handling, manual override
- `docs/transform-adapters.md` — cross-link to AI integration
- `examples/starter/sites/main/site.config.ts` — add commented-out `ai` and `altText` blocks
- `.claude/rules/design-media-implementation.md` — mark "AI alt-text adapter" row ✓ in v1.5 capabilities table
- `.claude/rules/design-ai-implementation.md` — mark commits ✓ as they land

## Branch and PR posture

- Branch: `ai-alt-v1.5` off `main`
- PR opens after commit 5 (abstraction proven by three providers); later commits push to the same PR
- Merge with `gh pr merge --rebase` per [team-preferences.md rule 16](team-preferences.md)
- CI runs on every push; broken intermediate commits fail PR checks but never main

## What's deferred from v1.5

### Tracked for v1.6+

| Item | Trigger to revisit |
|---|---|
| Per-target adapter override | Concrete operator request: "I need different providers per target" |
| `CachedAltSuggester` decorator | Operational measurement: cache hit would be > 30% in real workflows |
| Distributed cache (Redis-backed) | Multi-replica admin operators report duplicate-billing pain |
| Translation pipeline (`translateFrom: 'en'`) | Ollama users report bad non-English alt quality |
| Bulk-suggest CLI (`gazetta assets suggest-alt --all`) | Operators ask for backfill; design-media.md already lists this |
| Cost monitoring / budget caps | Site reports unexpected provider bills |
| Confidence field (real, not stub) | A provider exposes calibrated confidence for vision-description tasks |
| Custom prompt policies per site | Editorial style guides differ enough that the WCAG-grounded default doesn't fit |
| Image generation task | New blocks `imageGeneration:` and `packages/gazetta/src/imagegen/` directory |
| Tag suggestion task | Same shape as alt-text but different output structure |
| Summarization task | Text input not bytes; first text-task forces a `text-prep.ts` peer to `vision-prep.ts` |

### Translation as the canonical second consumer

Translation is the most likely v1.6 task. Its arrival validates the v1.5 architecture:
- `ai/refusal.ts` — reused; translation refusals look like alt refusals
- `ai/compose-prompt.ts` — reused; translation has its own policies
- `ai/prompt-policies.ts` — extends with translation-specific policies (preserve technical terms, formality, etc.)
- `ai/vision-prep.ts` — not used (text task)
- `ai/provider.ts` — `ResolvedAIBase` reused; `resolveTranslationConfig` peers `resolveAltConfig`
- `site.config.ts` — adds `translation` block; `ai` block unchanged
- `TargetInfo` — adds `translation: { available, configuredFor: ['fr', 'ar'] }` peer to `altText`

If translation lands cleanly with no `ai/` modifications, the v1.5 architecture passed. If `ai/` needs significant changes, the abstraction was wrong and gets restructured then — with two real consumers as evidence.

## Open implementation questions

1. **Anthropic SDK vision content format.** The SDK accepts image content as `{ type: 'image', source: { type: 'base64', media_type, data } }`. Verify: does the SDK accept `Uint8Array` directly, or do we need to convert to base64 string? Affects adapter performance for large bytes.

2. **OpenAI base64 data URL size limit.** OpenAI accepts `image_url` with `data:image/...;base64,...` URLs. Verify: is there a documented size cap for the data URL (i.e., post-base64 size ~33% larger than raw bytes)? At 768×768 JPEG quality 85, prep output is ~80 KB raw → ~107 KB base64 — well under typical request body limits, but verify.

3. **Ollama vision request shape.** Ollama's `/api/generate` accepts `images: [<base64>]`. Verify: which endpoint to use (`generate` vs `chat`) for best alt-text output? Test against `llama3.2-vision` 11b in particular.

4. **AbortSignal across SDK versions.** `@anthropic-ai/sdk` and `openai` both support AbortSignal in recent versions. Verify exact minimum versions; pin appropriately.

5. **Refusal marker maintenance.** Provider safety messaging drifts as models update. The marker list will need updates. Plan: review markers per major model version bump (e.g., when defaultModel changes from `claude-haiku-4-5` to `claude-haiku-5-0`); document maintenance expectation in `ai/refusal.ts` header comment.

6. **`auto: true` on bulk uploads.** A 50-asset upload with `auto: true` fires 50 parallel suggest calls. Each provider has its own rate limit (Anthropic 50 req/min on standard tier, OpenAI similar, Ollama unlimited but CPU-bound). Decision: rely on provider SDK retries (they handle 429s with backoff) for v1.5; admin-side throttling lands if measurement shows real pain. Document the trade in `docs/content-assets.md`.

7. **Locale fallback for unsupported locales.** Active locale is `pt-BR`; provider doesn't reliably write Brazilian Portuguese. Behavior: trust the model — modern vision models handle BCP-47 locale codes reasonably. If real use shows quality issues, the locale resolution chain (per design-media.md) gets honored: `pt-BR → pt → default-locale`. Document as a known limitation with workaround.

## Migration

### Existing sites

`site.config.ts` files without `ai` or `altText` blocks continue to work — schema validation treats both as optional. AI features stay off until configured.

### Pre-existing assets

Manual backfill via the detail-pane "✨ Suggest" button. No bulk-suggest CLI in v1.5 (deferred). Authors who want to backfill 100 existing assets click 100 times — acceptable for v1.5; CLI lands when scale demands it.

### Provider switching

Operator changes `ai.provider`:
1. Updates `.env.local` to provide new credentials
2. Restarts admin process (env read at boot; config read at first use)
3. Existing alt text is unchanged (alt is on assets, not in any provider-coupled cache)
4. New suggestions come from new provider

No data migration. Provider switch is config-only.

### Disabling AI

Operator removes `altText:` block (or sets per-target overrides as needed):
1. `isAltAdapterConfigured(target)` returns false
2. `/api/targets` reports `altText.available: false`
3. UI hides affordances on next load (SSE reload triggers refresh)
4. Existing alt text stays on assets; no destructive change

## Test infrastructure

### msw for HTTP mocking

All three adapters use `msw` (Mock Service Worker) for HTTP mocking in unit tests. This is new infrastructure for the codebase — adopted in commit 1 alongside the first adapter test.

**Why msw:** standard Node HTTP mocking; intercepts at the fetch/XHR layer (works with any SDK); fixture-friendly (canned response files). No real provider calls in CI; no real model in CI; deterministic.

**Pattern:**
```ts
// tests/alt-anthropic.test.ts (sketch)
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

const server = setupServer(
  http.post('https://api.anthropic.com/v1/messages', () => {
    return HttpResponse.json({
      content: [{ type: 'text', text: 'Mountain at sunset' }],
    })
  }),
)
beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

### No real-model CI tests in v1.5

Per the grilling decisions: real Ollama in CI requires 8 GB model download per run (disk + network); real SaaS calls cost money + are non-deterministic. msw tests prove the adapter speaks each provider's protocol correctly — that's what CI gates on.

**Future nightly real-model run** (Ollama only; SaaS is rate-limited + costly): runs once a week, asserts non-empty response, posts to workflow output for human review. Not gating. Lands when there's a documented drift incident; not v1.5.

## Estimates

Wall-clock for solo dev:

| Commit | Estimate |
|---|---|
| 1 (AI infrastructure) | 1 day |
| 2 (Adapter contract + null + suggester) | 1 day |
| 3 (Anthropic) | 1.5 days |
| 4 (OpenAI) | 0.5 day (after Anthropic-as-template) |
| 5 (Ollama) | 0.5 day |
| 6 (Config + factory) | 1 day |
| 7 (Admin route + capability) | 1 day |
| 8 (UI: upload-list + detail-pane) | 1.5 days |
| 9 (Docs + plan) | 0.5 day |

**Total: ~8.5 days.** With CI iteration + review feedback + the typical "first integration is harder than expected," budget ~2 weeks.

## SOLID checks per commit

Each commit's SOLID posture, validated at design time:

- **Commit 1**: SRP per module (refusal, vision-prep, prompt). OCP via composable policies + adapter-specific markers. No interfaces yet — pure utilities.
- **Commit 2**: ISP via narrow `AltTextAdapter` (just `supports` + `generate`). LSP validated by null adapter. DIP via `AltSuggester` depending on adapter abstraction.
- **Commits 3-5**: LSP across three real implementations. SRP — each adapter owns provider mechanics, nothing else (no UI, no config, no caching).
- **Commit 6**: SRP at config layer (each layer's resolver owns its layer). DIP via factory — adapters take literal config, never read env or YAML directly.
- **Commit 7**: SRP — route handler owns one concern (suggest-alt). DIP via suggester (route depends on abstraction, not on Anthropic/OpenAI/Ollama).
- **Commit 8**: ISP — UI components depend on `TargetInfo.altText` capability shape, not on adapter details. Provider-agnostic UI.

Any commit failing SOLID review at PR time is a structural correction (per [team-preferences.md rule 18](team-preferences.md)), not a patch — amend before merge if not yet pushed; new commit with clear "structural correction" message if already on the remote.
