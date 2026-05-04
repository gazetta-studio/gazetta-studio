---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "**/comment*"
  - "**/discussion*"
  - "**/mention*"
  - "**/notification*"
---

# Collaboration

Foundational dimension #13 of 13. v1 ships **comments-first**: page-level + inline + asset + review-event comments, mentions, in-admin notifications. Activity feed, presence, reactions, email/Slack notifications reserved for v2.

Discovered while grilling `design-review-workflow.md` Q1 (reject vs request-changes). Surfaced because the "approve-with-caveats" use case ("ship it but please fix typo on line 5") doesn't fit cleanly into a state machine — it's a conversation.

**Status**: design pass complete (2026-05). Implementation phases sit in Tier 3.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Collaboration check** every new feature design must answer once this dimension lands
- [`design-review-workflow.md`](design-review-workflow.md) — review approve/reject is the narrow state-machine; collaboration is the broader conversational surface
- [`design-auth-rbac.md`](design-auth-rbac.md) — capability vocabulary extends with comment / mention / subscribe gates
- [`design-audit.md`](design-audit.md) — collaboration events emit audit log entries

## Why this is foundational

Team CMSes don't just have state machines — they have conversations. Authors discuss content, reviewers leave inline feedback, ops coordinate releases, translators flag terminology questions. The collaboration surface is the cross-cutting layer that carries those conversations.

Adding collaboration later means retrofitting:
- Every content surface (page editor, asset detail, fragment editor) with comment threads
- Every action surface (review submit, publish request) with discussion attachment
- Audit log shape with comment events
- Notification primitives (in-admin, email, Slack, etc.)
- RBAC capabilities for comment / mention / subscribe / moderate

Doing it in front of the work that depends on it (review workflow's "request changes" semantics, presence's "Alice is typing in this comment thread", multi-author's handoff messaging) keeps the architectural shape clean.

## Why collaboration is its own dimension

**Not part of review workflow** — comments belong on draft content (pre-review), assets (alt-text discussion), publish requests (release notes), past audit events (postmortems). If we shipped comments inside review workflow, we'd retrofit every other surface later. Collaboration is the right umbrella; review workflow consumes it.

**Not part of audit log** — audit is structured forensic record; comments are unstructured human conversation. Different storage shape (audit per-revision; comments per-thread), different retention, different access pattern. Reuse where appropriate (audit records "Alice posted a comment" as `action: 'comment'`); separate primitives where shapes differ.

## Scope (Q1 locked)

**v1 ships**:
- ✓ **Page-level comments** (threads on whole pages)
- ✓ **Inline comments** (anchored to specific content paths within a manifest)
- ✓ **Asset comments** (alt-text discussion, licensing notes)
- ✓ **Review-event comments** (per `design-review-workflow.md` Q1; expanded to allow comments on approve/reject events too)
- ✓ **Mentions** (`@` picker; structured references; not text-parsed)
- ✓ **In-admin notifications** (bell icon + panel)
- ✓ `NotificationProvider` extension surface (v1 in-tree: `InAdminNotificationProvider` only)

**Reserved for v2+**:
- ✗ Activity feed (compose from audit log when demand surfaces)
- ✗ Presence / live cursors (Tier 3 strategic bet; needs real-time transport design)
- ✗ Reactions
- ✗ Email / Slack / webhook / Teams / Discord notifications (v2 expected order)
- ✗ Per-user notification preferences UI (deferred until email provider lands)
- ✗ Comment templates (saved reviewer comments)
- ✗ Approval-blocking comments (gate publish on resolved comments)
- ✗ File attachments
- ✗ Markdown formatting (plain text + mentions only in v1)

## Anchoring (Q2 locked)

Comments anchor at two scopes:

**Container scope** — page-level / fragment-level / asset-level. Thread attached to the whole item.

**Inline scope** — anchored to specific content within an item via stable component ID + optional field path:
- `componentId` — components gain explicit stable IDs (auto-generated when added; survive reorders)
- `fieldPath` — optional; path within the component's content (e.g., `title`, `metadata.publishedAt`)

**Component IDs are a structural change** to component manifests:

```yaml
# pages/home/page.json
components:
  - id: hero-001
    template: hero
    content: { ... }
  - id: featured-001
    template: featured
    content: { ... }
```

IDs auto-generate when components are added; stable thereafter; component reorders preserve them.

**Orphaned anchors** (component referenced by `componentId` was deleted): comment becomes orphaned; surfaces in a "Detached comments" list per item; not lost.

**Locale-agnostic by default**: one comment thread across all locales of the same content. Per-locale comments deferred to v2 if demand surfaces.

**Source-only**: comments live with source manifest, not target. Not per-target. Comments are about content, not deployment.

## Mentions + notifications + Notification Provider (Q3 locked)

### Mention syntax + storage

**`@` opens user picker** — typeahead/autocomplete; selection from list. Mentions stored as **structured references**, not parsed from text:

```ts
// Comment body segments
[
  { type: 'text', text: 'Looks good ' },
  { type: 'mention', userId: 'bob@example.com' },
  { type: 'text', text: ', let me know what you think.' },
]
```

User list source: audit log actors + trust mode's identity provider (Cloudflare Access groups, Azure AD users, etc.). Trust:none deployments: no user list; mentions disabled.

### Notification triggers

| Trigger | Default |
|---|---|
| You were mentioned | Notify (highest priority) |
| Someone replied to your comment | Notify |
| Someone replied to a thread you participated in | Notify (subscribe-on-participation) |
| Comment on content you authored | Notify (subscribe-on-content-ownership) |
| All comments on a page you bookmarked | Notify (explicit subscribe) |

### Notification Provider extension surface

```ts
interface NotificationProvider {
  readonly name: string
  /** Send notification to a user. Fails open per Universal Provider Requirement #5. */
  send(notification: Notification): Promise<void>
  /** Optional metadata for plugin-promotion UI. */
  capabilities?(): NotificationCapabilities
}

interface Notification {
  recipient: { id: string; email?: string }
  category: 'mention' | 'reply' | 'subscription' | 'content-comment'
  message: string
  link: string                   // deep-link to the relevant content
  metadata: Record<string, unknown>
}
```

**v1 in-tree**: `InAdminNotificationProvider` only. Stores notifications in `.gazetta/notifications/{recipient-id}/{notification-id}.json`; admin UI reads via `/api/notifications`.

**v2 expected order** (matches audit + alt-text expected-order pattern):

1. `EmailNotificationProvider` — most operators want email (configurable SMTP/SES/SendGrid)
2. `SlackNotificationProvider` — team-CMS context
3. `WebhookNotificationProvider` — universal sink for custom integrations
4. `MicrosoftTeamsNotificationProvider` — enterprise demand
5. `DiscordNotificationProvider` — community deployments

Plugin-supplied providers slot in via `api.registerNotificationProvider(name, factory)` per `design-plugins.md`.

### Notification storage + read state

```
.gazetta/notifications/{recipient-id}/{notification-id}.json
```

Per-edge sidecar pattern (matches asset-refs from `design-media.md`); multi-instance correct via per-edge granularity.

Read state: inline `readAt: ISO?` field on the notification. Last-write-wins on read = idempotent.

**Retention**: per-recipient cap (default 100 most-recent; oldest evicted) + 30-day implicit cap (whichever hits first). Operator-configurable: `admin.notifications.retention.maxPerRecipient: 200`.

### Notification fan-out

When a notification fires, it goes to:
- In-admin (always — `InAdminNotificationProvider`)
- Each configured external provider for the recipient's preferences

```ts
admin: {
  notifications: {
    providers: ['in-admin', 'email'],   // active providers (v2)
  },
}
```

Per-user preferences (which categories go to which provider): deferred to v2 with `EmailNotificationProvider`.

## Storage shape (Q4 locked)

```
.gazetta/comments/
  pages/
    home/
      threads/
        thread-{id}.json           # one per thread; per-edge granularity
        thread-{id}.json
      meta.json                     # aggregates: openThreads count, lastActivity
  fragments/
    header/
      threads/
        thread-{id}.json
  assets/
    hero/
      threads/
        thread-{id}.json
```

**Thread file shape**:

```json
{
  "id": "thread-2026-05-04T14:23-abc123",
  "scope": {
    "kind": "page",
    "name": "home",
    "componentId": "hero-001",
    "fieldPath": "title"
  },
  "messages": [
    {
      "id": "msg-001",
      "author": { "id": "alice@example.com", "email": "alice@example.com" },
      "createdAt": "2026-05-04T14:23:05Z",
      "editedAt": null,
      "body": [
        { "type": "text", "text": "This headline doesn't match " },
        { "type": "mention", "userId": "bob@example.com" },
        { "type": "text", "text": "'s tone." }
      ]
    }
  ],
  "resolved": false,
  "resolvedBy": null,
  "resolvedAt": null,
  "createdAt": "2026-05-04T14:23:05Z",
  "updatedAt": "2026-05-04T14:25:00Z"
}
```

**Concurrent thread writes**: etag-based optimistic concurrency. Each `thread.json` write uses `If-Match: <thread-etag>`. On mismatch, reply rejected; client refetches; retries with new etag. Same pattern as save-conflict from `design-offline.md` Q3.

**Thread IDs client-generated** — UUID at create time. Offline-friendly: comment posted offline gets ID; replays on reconnect with same ID; idempotent.

**Resolution capability**: anyone with `comment:write`. Audit log records who resolved; accountability via audit not gating.

**Edit / delete semantics**:

| Action | Allowed? | Audit |
|---|---|---|
| Edit own message | Yes (no time limit in v1) | `editedAt` updated; original NOT preserved |
| Edit others' messages | Only with `comment:moderate` | Yes |
| Delete own message | Yes | Soft delete: `{ deleted: true }`; body cleared |
| Delete others' messages | Only with `comment:moderate` | Yes |
| Delete entire thread | Author OR `comment:moderate` | Yes |

**Per-item `meta.json`** aggregates open thread count for site-tree badges. Updated atomically (etag-based) when thread state changes:

```json
{ "openThreads": 3, "lastActivity": "2026-05-04T14:25:00Z" }
```

Site tree reads `meta.json` (one file per item) — fast.

## RBAC (Q5 locked)

**5 new capabilities** (per `design-auth-rbac.md` capability vocabulary):

| Capability | Meaning |
|---|---|
| `read:comments` | View comment threads on items the user can read |
| `comment:write` | Post / reply / resolve comments |
| `comment:moderate` | Edit or delete others' comments |
| `mention:any` | Mention anyone (default: only mention people who can access the same content) |
| `subscribe:any` | Subscribe to any item's comment activity (default: only items you can read) |

**Default role aliases extended**:

| Role | Comment capabilities |
|---|---|
| `admin` | All (`*`) |
| `editor` | `read:comments`, `comment:write`, `mention:any`, `subscribe:any` |
| `viewer` | `read:comments` (read-only) |

**Custom role examples**:
- `commenter` = viewer + `comment:write`
- `moderator` = editor + `comment:moderate`

**Visibility cascading**: comment visibility follows content visibility. If author can read page X, they can read comments on page X. Enforced at API layer.

**Mention privacy**: picker filters user list to those with access to the content. Prevents existence-leak. `mention:any` capability bypasses the filter (admin role typically).

**Notification visibility**: scoped by recipient identity. `GET /api/notifications` returns only the principal's own notifications; no cross-user leakage.

**Moderation surface**: `comment:moderate` allows editing/deleting others' comments. Banning users from commenting is operator-removes-role; not a comment-layer concern.

**Audit moderation actions** explicitly: `action: 'comment-moderate'` records the moderation event with target user, original action, optional reason metadata.

**Comments do NOT block publish** in v1. Approval-blocking comments reserved for v2 (per Q1 scope lock).

**RTBF** (right-to-be-forgotten) — `gazetta audit scrub --actor=alice@example.com` extends to:
- Comment messages by Alice: `author.id` and `author.email` replaced with `[scrubbed-{hash}]`
- Mentions of Alice: replaced with `[scrubbed-{hash}]` placeholder
- Notifications sent to Alice: deleted entirely
- Notifications about Alice: mention reference replaced

Scrub records `action: 'comment-scrub'` for forensic trail.

## UX (Q6 locked) — Krug-aligned

Per [team-preferences rule 23](team-preferences.md): absence is a state; universal icons over jargon; no help-tooltips-as-bandaid.

### Indicator placement (only when noteworthy)

| Surface | Indicator |
|---|---|
| Site tree | Chat-bubble icon + count on items with **open** threads (resolved hidden by default) |
| Editor toolbar | Bubble icon for page-level threads |
| Inline content | Bubble icon next to fields with threads; click opens floating popup |
| Asset library | Bubble icon on cards with comments |
| Top bar | Bell icon for notifications; unread count badge |

When zero comments / zero notifications: no icon. The absence IS the state.

### Comment thread panel (page-level)

- Side panel; threads sorted by recent activity
- Each thread: anchor ("Page-level" or "Hero — Title field"), latest message preview, message count, open/resolved state
- No "Comments (3)" header — the panel content is self-evident
- Resolved threads hidden by default; "Show 3 resolved" toggle

### Inline comment popup

- Small floating panel anchored near the field
- Shows thread + reply input
- Click outside → closes
- Compact; doesn't disrupt editor layout

### Mention picker

- `@` triggers picker below cursor
- Filtered autocomplete; arrow keys navigate; Enter/Tab selects; Esc closes
- Filtered by content access (Q5 lock)
- Keyboard-first; familiar pattern from Slack/GitHub/Linear

### Notification panel

- Bell icon click → chronological list
- Each row: avatar + 1-line summary + timestamp
- Click row → navigate + mark read
- Unread highlighted; read quiet
- Badge: count up to "9+"; absent when zero

### Comment composition

- Plain text + structured mentions
- `Cmd/Ctrl+Enter` to post (or button)
- **No Markdown** in v1
- **No file attachments** in v1
- **No formatting toolbar** — minimal affordances per Krug

### First-time-comment UX

- No onboarding tooltip
- Empty thread panel + input box with "Add a comment..." placeholder
- Self-evident affordance

### Offline integration

- Pending comment posts show cloud-with-slash icon (per `design-offline.md` lock)
- Comment threads visible from L6 cache while offline
- Replay on reconnect with `If-Match` etag

### Accessibility

- Bell icon: aria-label "Notifications, N unread"
- Comment bubble icon: aria-label "Comments, N open" (or "Add comment" if zero)
- Thread panel: keyboard navigable; arrow keys between messages; Tab to reply input
- Mention picker: screen reader announces matches
- Color-coded states paired with text labels

## Composition with hooks

Hooks fire on collaboration events per `design-hooks.md`'s extension surface:

| Hook phase | When it fires |
|---|---|
| `afterCommentPosted` | After a comment is created |
| `afterCommentEdited` | After a comment is edited |
| `afterCommentDeleted` | After a comment is deleted (soft or hard) |
| `afterCommentResolved` | After a thread is resolved |
| `afterMention` | After a mention is created (composes with notification dispatch) |
| `beforeCommentPosted` | Before a comment is committed (mutating; can cancel via throw) |

Plugin authors wire external systems via these hooks (Linear ticket on comment-with-`#bug`, Slack DM on mention, etc.).

Per `design-hooks.md` Q3 lock: hooks fire in priority order; `afterMention` hooks are independent (parallel); `beforeCommentPosted` chains.

## Composition with offline

Comments queue offline + replay on reconnect (matches save replay pattern from `design-offline.md`):
- Author posts comment offline → enters save queue
- Mention notifications fire on replay (not on offline post — recipient can't act on a notification while sender is offline)
- Conflict on replay (rare — comments rarely conflict structurally) handled per offline conflict UX

## Foundational checks

How collaboration composes with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Per-thread sidecar files (`.gazetta/comments/{kind}/{name}/threads/{thread-id}.json`) — multi-instance correct via per-edge granularity
- Concurrent thread writes use etag-based optimistic concurrency (matches save-conflict pattern); concurrent posts to different threads don't race
- Notifications per-recipient sidecars; multi-instance correct
- Client-generated thread IDs (UUIDs) — no server-side ID coordination needed

### Scale (#1)
- Per-thread file granularity bounds size per file (typically 1-100 messages per thread)
- Per-item `meta.json` aggregates open count for site-tree badges (avoids reading all threads to compute badge)
- At envelope (~5K pages × 5 threads avg = 25K thread files): O(1) read per thread; manageable
- Notification retention (per-recipient cap 100 + 30-day implicit) bounds notifications per recipient

### Locale (#2)
- Comments locale-agnostic by default — one thread across all locales of the same content (per Q2 lock)
- Per-locale comments deferred to v2 if demand surfaces

### Themes (#3)
- Comments theme-agnostic — content discussion, not theme presentation

### Auth + RBAC (#4)
- 5 new capabilities: `read:comments`, `comment:write`, `comment:moderate`, `mention:any`, `subscribe:any`
- Default role aliases extended (editor + viewer per Q5 lock)
- Comment visibility cascades from content read access
- Mention picker filters by content access (prevents existence-leak); `mention:any` bypasses
- Notification visibility scoped by recipient identity

### Audit (#5)
- Every comment write/edit/delete records audit event
- Audit `action` enum extends with: `comment-post`, `comment-edit`, `comment-delete`, `comment-resolve`, `comment-reopen`, `mention-fired`, `notification-sent`, `comment-moderate`, `comment-scrub`
- Closed-enum extensions (matches the pattern from review-workflow Q1 + audit Q1)

### Review (#6)
- Comments compose with review-workflow's reject reason (per `design-review-workflow.md` Q1)
- Approve/reject/withdraw transitions can carry inline comments
- Comments do NOT block publish in v1 (approval-blocking deferred to v2)

### Hooks (#7)
- 6 new hook phases: `beforeCommentPosted`, `afterCommentPosted`, `afterCommentEdited`, `afterCommentDeleted`, `afterCommentResolved`, `afterMention`
- Plugin authors wire external systems (Linear ticket creation, Slack DM, etc.)
- `beforeCommentPosted` hooks can throw to cancel (e.g., spam filter); `after*` hooks are observational

### Render (#8)
- Comments don't affect rendered output; comment data lives in `.gazetta/` (runtime ignores)
- Future: comment counts surfaced in render-time queries via `helpers.comments` API (deferred to v1.5+)

### Validation (#9)
- No comment-specific validators in v1
- Future: validators that check "X open comments must be resolved before publish" (approval-blocking comments — v2 scope)

### Plugin (#10)
- `NotificationProvider` is Extension Surface #12 (per Q3 lock)
- Plugin-supplied notification providers register via `api.registerNotificationProvider(name, factory)` per `design-plugins.md` Q3
- Plugin-supplied hooks compose with the 6 collaboration hook phases

### Cache (#11)
- Comment thread results cached per-item by `MemoryCache` (server-side L4)
- L6 (browser-side via `IndexedDBCache`) caches comment threads for offline read
- Cache invalidation on comment write via SSE broadcast (existing cascade mechanism)
- Per-item `meta.json` content hash drives cache key

### Offline (#12)
- Comments work offline: posts queue on save queue; replay on reconnect
- Pending comments show cloud-with-slash icon (per `design-offline.md` UX lock)
- Mentions in offline comments fire notifications on replay (not on offline post)
- Conflict resolution: rare for comments; same UX as save conflicts

### Site config (`design-config.md`)
- Per-site `admin.notifications.providers` config drives notification fan-out
- `admin.notifications.retention` for retention policy
- Multi-site: each site's collaboration state independent (per-site cache + per-site comments)

## Migration

Sites without collaboration features continue to work — collaboration is additive. Comment threads live in a reserved namespace (`.gazetta/comments/`) that runtime ignores. RBAC defaults grant `comment:write` to editor + admin roles only.

**Component-ID structural change**: existing component manifests don't have explicit `id` fields. Migration: on first save after upgrade, components get auto-generated IDs persisted to the manifest. Subsequent saves preserve IDs. Pre-upgrade comments (none exist; new feature) so no anchor migration needed.

## Future directions

- **Activity feed** — composes from audit log; "what happened in the last day across the site"; per-user feed; per-content feed
- **Real-time presence** — "Alice is editing /home"; needs WebSocket / persistent SSE; Tier 3 strategic bet
- **Reactions** — lightweight signals (thumbs up, eyes) on comments
- **Email / Slack / Webhook / Teams / Discord notification providers** — v2 expected order per Q3
- **Per-user notification preferences UI** — settings page with per-category × per-provider checkboxes; lands with email provider
- **Comment templates** — saved reviewer comments ("Please add alt text") as one-click
- **Approval-blocking comments** — opt-in mode where unresolved comments block publish (compliance archetype)
- **File attachments on comments** — image/document upload with comments
- **Markdown formatting in comments** — formatting bar; rendered in thread view
- **External system bridges** — GitHub Discussions, Linear, Jira via hooks
- **Translation discussion** — terminology questions per locale variant; composes with per-field translation
- **Per-locale comments** — when concrete demand surfaces
- **Comment search** — when comment volume grows large
- **Edit window restriction** — operator-configurable "no edit after N minutes"
