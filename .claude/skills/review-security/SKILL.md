---
name: review-security
description: Security review for the diff — capability gates on admin routes, SSRF on URL fetching, unsanitized HTML/SVG injection, secret leakage in logs / error messages, dependency-version CVE risk, RBAC bypass patterns. Fires when admin-api/, providers/, files containing 'sanitize'/'capability'/'auth', package.json, or fetch()/exec()/child_process content is touched.
allowed-tools: Bash Read Grep Glob
argument-hint: [--base <ref>] [--pr <N>]
---

# Review-security — Phase 2 angle

Security findings dominate the CRITICAL severity category — a missed capability gate is a privilege escalation, a missed sanitization is XSS, a logged secret is a credential leak. This angle is tuned to flag those classes aggressively while keeping the ≥ 80 confidence floor.

See [`design-code-review.md`](../../rules/design-code-review.md) for the full design + skill family.

## What this angle owns

- **Missing capability gates** on admin API routes (per [`design-auth-rbac.md`](../../rules/design-auth-rbac.md))
- **RBAC bypass** patterns — code that reads from a `Principal` without checking the capability the operation requires
- **SSRF** — URL-fetching code (`fetch(`, `axios.get`, `http.get`) without an allow-list or RFC-1918 block
- **Unsanitized HTML/SVG/MathML rendering** — `innerHTML`, `v-html`, `dangerouslySetInnerHTML` with user-controlled input
- **Path traversal** — file system access with user-controlled paths (no `path.resolve` containment check)
- **Command injection** — `exec(...)`, `child_process.spawn(... { shell: true })` with user-controlled args
- **Secret leakage** — env vars, tokens, or credential-shaped strings in `console.log`, error messages, or stack traces
- **Dependency-version CVE risk** — when `package.json` adds or bumps a dependency with a known CVE
- **Insecure crypto** — MD5/SHA-1 for security (not content-addressing), `Math.random()` for tokens, hardcoded secrets
- **Missing CSRF protection** on state-changing routes (if the framework's protection isn't present by default)

## What this angle does NOT own

- General logic bugs (`review-diff`)
- Whether the auth/RBAC DESIGN is right (that's `review-architecture` or a separate design pass)
- Test-time security (tests that fake auth are fine; production code that fakes auth is a finding)
- Build-time security (lockfile integrity, supply chain) — limited to dep-bump CVE check in this angle
- Security of upstream services (the CDN, the runtime platform) — out of repo scope

## Reads (always)

- [`.claude/rules/design-auth-rbac.md`](../../rules/design-auth-rbac.md) — capability model, Principal type, trust modes, RBAC patterns
- [`CLAUDE.md`](../../../CLAUDE.md) — security-related guidance (SSRF protection, deny .env reads/writes via permissions, etc.)

## Reads (on demand)

| Diff touches… | Read |
|---|---|
| `*sanitize*`, SVG/HTML rendering | [`design-media.md`](../../rules/design-media.md) "Security" + DOMPurify config |
| `packages/gazetta/src/providers/` (storage / R2 / S3) | [`design-provider-config.md`](../../rules/design-provider-config.md) — credentials via env, never literal |
| `packages/gazetta/src/cache/` | [`design-cache.md`](../../rules/design-cache.md) — cache poisoning surfaces |
| `package.json` dependency bumps | check the dep's CHANGELOG for known CVEs / breaking changes |

Max 1 additional doc per invocation.

## Severity assignment

Security findings are weighted toward higher severity than other angles. The floor is still ≥ 80 confidence; the ceiling skews higher:

| Severity | When |
|---|---|
| **CRITICAL** | Privilege escalation (missing capability gate, RBAC bypass); credential leak; SSRF reachable from user input; XSS via unsanitized render; data exfiltration; sql/command injection (if applicable). Confidence ≥ 90. |
| **IMPORTANT** | Defense-in-depth gap (no input length cap; permissive CORS; weak crypto for non-security use that's MIGRATING toward security; missing rate limit on a public endpoint). Confidence ≥ 80. |
| **NIT** | Style preference about how to express a security check; minor improvements to existing protection. Confidence ≥ 80. |

**Default to higher severity when uncertain.** Security false negatives are expensive; security false positives at ≥ 80 confidence with a real `rule` citation are recoverable.

## Process

### 1. Identify security-sensitive paths in the diff

Look for paths the dispatch already flagged: `admin-api/`, `providers/`, `*sanitize*`, `*capability*`, `*auth*`, `package.json`. Also content-based: `fetch(`, `child_process`, `exec(`.

### 2. Walk each file against the security checklist

For each file, run through the relevant checks:

**For admin-api/ routes:**
- Does the route declare `requireCapability(...)` (or equivalent middleware)?
- Does the capability match the operation (e.g., `edit:pages` for PUT /api/pages, `delete:pages` for DELETE)?
- Per `design-auth-rbac.md`, built-in prefixes are `read / edit / delete / publish / configure / review / restore / comment / mention / subscribe`. Verify the choice fits.
- Does the route read `Principal` from the request? If so, is the capability check performed BEFORE the read uses authority-derived data?

**For URL-fetching code:**
- Is the URL user-controlled?
- Is there an allow-list of valid hosts/protocols?
- Is RFC-1918 / loopback / link-local blocked at upload time (per `design-media.md` security)?
- For `fetch` calls in providers: is the URL constructed from operator config (safe) or user input (risky)?

**For HTML/SVG rendering:**
- Any `v-html`, `innerHTML`, `dangerouslySetInnerHTML` calls?
- Is the content sanitized via DOMPurify with the appropriate profile (HTML or SVG)?
- For SVG uploads: are `<script>`, event handlers, `xlink:href` external refs stripped per `design-media.md`?

**For file system access:**
- Is the path user-controlled?
- Is `path.resolve` used to normalize? Is the result checked to be within an allowed base directory?
- Are reserved names rejected (`.gazetta/`, `.env`, paths starting with `.`)?

**For exec / spawn:**
- Are user-controlled args passed?
- Is `shell: true` set anywhere (shell injection surface)?
- Could a path-with-spaces or quote in an argument escape into shell context?

**For logging:**
- Does any log statement interpolate `process.env.X`, `apiKey`, `token`, `password`, `Authorization` headers, or auth-cookie values?
- Per `design-logging.md`, structured logs must exclude PII (auth tokens, manifest content, comment bodies, asset bytes).

**For dependency bumps in package.json:**
- Bump from N to N+major: check the bumped package's release notes for breaking changes
- Bump that introduces a transitive dep: validate the lockfile change is intentional
- Skip CVE deep-dive (not enough context); flag the bump for human review when it's an unfamiliar package

**For crypto:**
- Hash for content-addressing (file hashes): MD5/SHA-1/SHA-256 all acceptable; SHA-256 preferred for new code per `design-media-implementation.md`
- Hash for security (signatures, MAC, password): MUST be SHA-256+ / HMAC / argon2 / bcrypt
- Random for security (tokens, secrets): MUST be `crypto.randomUUID()` or `crypto.randomBytes()` — never `Math.random()`

### 3. Form findings + cite the rule

Citations are typically:
- `design-auth-rbac.md#capability-gate` (or specific anchor)
- `design-media.md#security` (sanitization)
- `design-logging.md` (PII in logs)
- `CLAUDE.md` (general security guidance)
- `<file-name>:<line>` (when the issue is purely about the code with no doc to cite)

### 4. Emit prose + findings fence

Above the fence, emit `> Decision: ...` notes for:
- Which files you walked
- Which security categories you checked (briefly)
- Specific high-confidence findings + why they earn CRITICAL/IMPORTANT
- Any candidate findings that didn't clear ≥ 80 confidence (especially security ones — these need explanation since dropping a security finding is a higher-stakes decision)

Findings fence (possibly empty):

````
```findings
{"severity":"CRITICAL","file":"packages/gazetta/src/admin-api/routes/users.ts","line":42,"confidence":92,"category":"security","rule":"design-auth-rbac.md#capability-gate","message":"PUT /api/users/:id route doesn't declare requireCapability(); any authenticated principal can modify any user","suggestion":"add `requireCapability('edit:users')` middleware before the handler; verify principal can edit the targeted user-id"}
```
````

When NO findings ≥ 80 confidence:

````
> Decision: walked N files in security-sensitive paths. Checked: capability gates on admin-api routes, URL-fetching for SSRF, HTML/SVG rendering for XSS, fs paths for traversal, logging for secret leakage, package.json for dep-bump risk. No concerns ≥ 80 confidence. (Capability gates verified present on the 3 routes touched; URL fetch in providers/ is constructed from validated operator config, not user input.)

```findings
```
````

## Anti-patterns (illustrative)

**Missing capability gate:**
```ts
app.put('/api/admin/users/:id', async (c) => {
  const id = c.req.param('id')
  await db.update(id, ...)  // no capability check; any authenticated user can call this
})
```
→ Add `requireCapability('edit:users')` before the handler.

**SSRF without allow-list:**
```ts
async function fetchAsset(url: string) {  // url is from user upload
  const r = await fetch(url)  // could resolve to 169.254.169.254 (cloud metadata)
  return r.bytes()
}
```
→ Block RFC-1918 + 169.254.*; require https scheme; allow-list trusted hosts (per `design-media.md` security).

**Unsanitized v-html:**
```vue
<div v-html="user.bio"></div>  <!-- bio is user-controlled HTML -->
```
→ Sanitize via DOMPurify before rendering; or use plain text binding.

**Secret in logs:**
```ts
logger.error({ env: process.env, err })  // dumps every env var
```
→ Whitelist what's logged: `logger.error({ requestId, err: { name, message } })`.

**Math.random() for token:**
```ts
const sessionId = Math.random().toString(36).slice(2)
```
→ `const sessionId = crypto.randomUUID()` or `crypto.randomBytes(16).toString('hex')`.

**Path traversal:**
```ts
const filePath = path.join(uploadsDir, req.body.name)  // name could be '../../etc/passwd'
await fs.readFile(filePath)
```
→ Use `path.resolve(uploadsDir, name)` and check the result starts with `path.resolve(uploadsDir)`.

**Command injection:**
```ts
exec(`git diff ${branch}`)  // branch is user-controlled; could be 'main; rm -rf /'
```
→ `execFile('git', ['diff', branch])` (no shell interpolation; args are arguments, not shell text).

## What NOT to flag

- Testing fixtures that fake auth (tests/_helpers/, *.test.ts) — that's the test pattern, not production code
- Server-side use of `fetch` to call known internal services (no user input → no SSRF)
- File system access where the path is from a hardcoded constant or operator config
- Trust modes themselves (whether the project should use trust mode X is a design question)
- Production-vs-dev branch differences if the dev branch fakes auth but the prod path is gated

## When to invoke

Fires from the orchestrator when the dispatch detects security-sensitive paths or patterns (per `bots/_lib/review-dispatch.ts:matchesSecurity`). Direct invocation (`/review-security`) is supported for focused review.

Also invoked from fix-bot's reviewer Step 3b when the fix's diff touches a security-sensitive path.

## Stop conditions

- Stop if the diff has no security-sensitive files or content
- Stop after walking the checklist for each relevant file
- Emit findings (possibly empty + prose)

## Decision-log convention

Emit `> Decision: ...` notes for:
- Which security categories were checked (capabilities / SSRF / sanitization / fs / exec / logging / deps / crypto)
- High-confidence findings with their citations
- Dropped findings (security ones especially — note WHY you dropped: "candidate finding at confidence 75 about a `fetch` call, but the URL is from operator config not user input — dropped")
- When confidence assignment is borderline, lean toward the higher severity for security per the locked policy
