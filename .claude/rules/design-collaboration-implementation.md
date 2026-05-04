---
paths:
  - "packages/gazetta/src/collaboration/**"
  - "packages/gazetta/src/notifications/**"
  - "apps/admin/src/client/components/comments/**"
---

# Collaboration — Implementation

Companion to [design-collaboration.md](design-collaboration.md). Cut sequence with risk ordering.

See [design-collaboration.md](design-collaboration.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `collaboration-v1` off `main`. Sequenced after AuthIdentity + Audit + Component IDs + NotificationProvider per Phase 1 dependency order. **No backwards compatibility**.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | Component ID generation: auto-generate stable IDs on save when missing | ☐ | Medium | Anchor primitive |
| 2 | `collaboration/` infrastructure: `Comment`, `CommentThread`, `Mention` types | ☐ | Low | Type foundation |
| 3 | Storage: per-thread sidecars at `.gazetta/comments/{kind}/{name}/threads/{id}.json` | ☐ | Medium | Per-edge storage shape |
| 4 | Etag-based concurrency: `If-Match` on thread updates | ☐ | Medium-high | Thread-update race correctness |
| 5 | API endpoints: `GET/POST/PATCH/DELETE /api/comments/{kind}/{name}` | ☐ | Medium | Server-side comment CRUD |
| 6 | RBAC capabilities: `read:comments`, `comment:write`, `comment:moderate`, `mention:any`, `subscribe:any` | ☐ | Low | Capability vocabulary extension |
| 7 | Mention picker UI + structured mention storage (not text-parsed) | ☐ | Medium | Mention authoring UX |
| 8 | NotificationProvider: `InAdminNotificationProvider` v1 + dispatch on mention | ☐ | Medium | Notification primitive |
| 9 | Notification storage: `.gazetta/notifications/{recipient}/{id}.json` per-edge | ☐ | Low-medium | Notification persistence |
| 10 | Notification UI: bell icon + panel + read state | ☐ | Medium | Visible feature |
| 11 | Comment thread UI: site tree badge + editor toolbar bubble + inline floating popup | ☐ | High | Comment UX surface (largest UI work) |
| 12 | Per-item meta.json aggregation: open-thread count for site-tree badges | ☐ | Low | Performance for tree rendering |
| 13 | RTBF scrub extension: comments + mentions + notifications | ☐ | Low | Compliance |
| 14 | 6 hook phases: `beforeCommentPosted`, `afterCommentPosted`, `afterCommentEdited`, `afterCommentDeleted`, `afterCommentResolved`, `afterMention` | ☐ | Low-medium | Hooks integration |
| 15 | Audit integration: 9 new `action` enum values | ☐ | Low | Audit composition |
| 16 | Docs + example | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: Component ID generation

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` + `fragments.ts` — on save, components without `id` field get auto-generated IDs (NanoID format)
- `packages/gazetta/src/types.ts` — `ComponentManifest` extends with optional `id?: string` (always populated post-save)

**Tests:** save adds IDs to ID-less components; existing IDs preserved across saves

**Why first:** anchor primitive for inline comments; needs to land before any inline-anchored comment can exist.

### Cut 2: Infrastructure

**Files added:**
- `packages/gazetta/src/collaboration/types.ts` — `Comment`, `CommentThread`, `Mention`, `MessageBody` (structured segments)
- `packages/gazetta/src/collaboration/errors.ts`
- `packages/gazetta/src/collaboration/index.ts`

### Cut 3: Storage

**Files added:**
- `packages/gazetta/src/collaboration/storage.ts` — read / write thread files; per-edge granularity

**Tests:** thread CRUD round-trip; multi-instance write isolation

### Cut 4: Etag concurrency

**Files modified:**
- `packages/gazetta/src/collaboration/storage.ts` — `If-Match` enforcement on thread writes; throw `409 STALE` on mismatch

**Files added:**
- Storage provider extensions: etag-conditional-write where supported (R2, S3, Azure native; filesystem provider via write-then-rename + content-hash)

**Tests:** concurrent writes to same thread → second fails with STALE; client retry resolves

### Cut 5: API endpoints

**Files added:**
- `packages/gazetta/src/admin-api/routes/comments.ts` — CRUD endpoints
- `packages/gazetta/src/admin-api/schemas/comments.ts` — Zod schemas

**Tests:** API integration tests per endpoint

### Cut 6: RBAC capabilities

**Files modified:**
- `packages/gazetta/src/auth/capabilities.ts` — add 5 new capabilities
- `packages/gazetta/src/auth/roles.ts` — extend default role aliases (editor: + comment:write, mention:any, subscribe:any; viewer: + read:comments)
- `comments.ts` route — gate endpoints on capabilities

**Tests:** 403 for missing capability; comment visibility cascades from content read access

### Cut 7: Mention picker

**Files added:**
- `apps/admin/src/client/components/comments/MentionPicker.vue` — `@`-triggered picker; filters by content access
- `apps/admin/src/client/components/comments/MessageEditor.vue` — text + structured mentions

**Tests:** typing `@` opens picker; selection inserts structured reference; user list filtered correctly

### Cut 8: NotificationProvider + dispatch

**Files added:**
- `packages/gazetta/src/notifications/types.ts` — `Notification`, `NotificationProvider` interface
- `packages/gazetta/src/notifications/providers/in-admin.ts` — `InAdminNotificationProvider`
- `packages/gazetta/src/notifications/dispatcher.ts` — fan-out to configured providers

**Tests:** mention triggers notification dispatch; provider receives notification

### Cut 9: Notification storage

**Files modified:**
- `packages/gazetta/src/notifications/providers/in-admin.ts` — per-edge sidecar storage; retention pruner (100-recent + 30-day cap)

**Tests:** notification persists; retention prunes correctly

### Cut 10: Notification UI

**Files added:**
- `apps/admin/src/client/components/notifications/NotificationBell.vue` — bell icon with unread count
- `apps/admin/src/client/components/notifications/NotificationPanel.vue` — chronological list
- `apps/admin/src/client/stores/notifications.ts` — Pinia store

**Tests:** unread count updates; click marks read; navigation to comment works

### Cut 11: Comment thread UI

**Files added:**
- `apps/admin/src/client/components/comments/CommentBubble.vue` — universal icon component
- `apps/admin/src/client/components/comments/CommentPanel.vue` — page-level side panel
- `apps/admin/src/client/components/comments/InlineCommentPopup.vue` — floating popup for inline anchors
- `apps/admin/src/client/components/comments/CommentThread.vue` — thread display
- `apps/admin/src/client/components/comments/AssetCommentBadge.vue` — asset library card badge

**Tests:** comment workflow end-to-end (post / reply / resolve)

### Cut 12: meta.json aggregation

**Files modified:**
- `packages/gazetta/src/collaboration/storage.ts` — atomic update of `.gazetta/comments/{kind}/{name}/meta.json` on thread state changes

**Tests:** site tree reads meta.json; counts accurate

### Cut 13: RTBF scrub

**Files modified:**
- `packages/gazetta/src/audit/scrub.ts` (extends from audit Phase 1) — extend to scrub comments + mentions + notifications

**Tests:** scrubbing actor X removes / redacts X's comments + mentions of X + X's notifications

### Cut 14: Hook phases

**Files modified:**
- `packages/gazetta/src/hooks/types.ts` — add 6 hook phase types
- Comment CRUD endpoints — `dispatchBefore` / `dispatchAfter` per phase

**Tests:** hooks fire on comment lifecycle; can cancel via beforeCommentPosted

### Cut 15: Audit integration

**Files modified:**
- `packages/gazetta/src/audit/types.ts` — extend `action` enum with `comment-post`, `comment-edit`, `comment-delete`, `comment-resolve`, `comment-reopen`, `mention-fired`, `notification-sent`, `comment-moderate`, `comment-scrub`

**Tests:** every comment lifecycle event records audit

### Cut 16: Docs

**Files added/modified:**
- `docs/collaboration.md` (NEW)
- `examples/starter` — add example use case

## Validation gate (definition of done)

- [ ] All 16 cuts merged
- [ ] End-to-end author workflow: post comment → mention colleague → colleague gets notification → reply → resolve
- [ ] Hooks fire correctly across comment lifecycle
- [ ] Audit log records all collaboration actions

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Email/Slack/Webhook/Teams/Discord NotificationProviders (v2 expected order) | Operator demand per provider |
| Per-user notification preferences UI | Lands with email provider |
| Activity feed | Operator demand; composes from audit log |
| Reactions on comments | Operator demand |
| Comment templates | Operator demand |
| Approval-blocking comments | Compliance archetype demand |
| File attachments | Operator demand |
| Markdown formatting | Operator demand |
| Per-locale comments | Concrete demand |
| Real-time presence | Tier 3 strategic bet (deferred) |
| Live comment streams (SSE push of new comments) | Composes with presence |

## Open implementation questions

1. **NanoID vs UUID for component IDs**: NanoID is shorter (21 chars vs 36) and URL-safe; recommend NanoID. Component IDs appear in audit metadata; shorter is friendlier.
2. **Comment count badge update strategy**: Vue Query invalidation cascade — when thread state changes, invalidate `comments:meta:{kind}:{name}`; site tree refetches.
3. **Mention picker user list source**: at v1, audit log actors who've performed write events on this content + content access list. Cached per-page; refreshed on write events.

## Estimates

| Cut | Estimate |
|---|---|
| 1 (Component IDs) | 1 day |
| 2-3 (Infra + storage) | 1.5 days |
| 4 (Etag) | 1 day |
| 5-6 (API + RBAC) | 1.5 days |
| 7 (Mention picker) | 1.5 days |
| 8-9 (Notification dispatch + storage) | 1.5 days |
| 10 (Notification UI) | 1.5 days |
| 11 (Comment UI — largest cut) | 3 days |
| 12-13 (meta.json + RTBF) | 1 day |
| 14-15 (Hooks + audit) | 1 day |
| 16 (Docs) | 1 day |

**Total: ~16-17 days.** Largest scope of any Phase 1 foundation; budget ~3-4 weeks with iteration.

## SOLID checks per cut

- **Cut 1**: SRP — component ID generation is one concern; auto-generate is a save-handler enrichment, not buried in unrelated logic.
- **Cut 3-4**: storage shape isolated; etag concurrency is a separate module.
- **Cut 7**: mention picker is one component; structured mention storage is one type.
- **Cut 11**: comment UI components have single responsibilities each (bubble icon = display badge; popup = inline thread; panel = page-level threads).
- **Cut 13**: RTBF scrub composes with audit's existing scrub primitive; doesn't duplicate logic.
- **Cut 14-15**: hook integration + audit integration are additive; comment CRUD doesn't change shape.
