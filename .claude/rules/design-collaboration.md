---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "**/comment*"
  - "**/discussion*"
  - "**/mention*"
  - "**/notification*"
---

# Collaboration — design pass pending

Foundational dimension #13 of 13. Comments, mentions, notifications, activity feed, presence — the conversational and awareness layer that team CMSes need.

Discovered while grilling `design-review-workflow.md` Q1 (reject vs request-changes). Surfaced because the "approve-with-caveats" use case ("ship it but please fix typo on line 5") doesn't fit cleanly into a state machine — it's a conversation. Collaboration is the umbrella for those conversations and the surfaces that carry them.

**Status**: design pass pending — sequenced after the team-CMS core (`design-auth-rbac.md`, `design-audit.md`, `design-review-workflow.md`). Likely Tier 3 implementation.

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

## Surface area sketch (to formalize in design pass)

What collaboration likely covers:

### Comments / discussion threads
- **Page-level comments** ("This headline isn't right for the campaign")
- **Inline comments** anchored to a content path within a manifest ("This image needs a redo — too low contrast")
- **Asset-level comments** ("Use this for blog header but not hero")
- **Review-event comments** ("Approving with caveats — fix line 5 typo before publish")
- **Publish-request comments** ("Why is this going to prod outside the release window?")
- Threading model — flat vs nested vs single-reply
- Resolution state — open / resolved / archived
- Edit / delete semantics — author-only edit; admin-moderate; audit retains history

### Mentions
- `@username` syntax in comments and free-text fields
- Notification trigger
- Capability gate — `mention:any` vs `mention:role:editor`
- Privacy — mentioning someone reveals their existence to the mentioner

### Notifications
- In-admin (badge + drawer)
- Out-of-band (email, Slack, webhook) — pluggable surface, possibly Notification Provider as Extension Surface #12
- Subscription model — opt-in per content / target / global
- Per-event preferences — "notify me on review requests but not on every save"
- Digest mode — accumulate and batch (daily, hourly)
- Quiet hours / timezones

### Activity feed
- "What happened in the last day across the site?"
- Per-user feed — "things that touched my work"
- Per-content feed — "everything that's happened on this page"
- Composes with audit log as event source (per the real-time event-source discipline)

### Presence (existing reserved Tier 3)
- "Alice is editing /home"
- "Bob is reviewing the publish request"
- Cursor / selection sharing — separate concern (presence-MVP first; concurrent editing far-future)

### Reactions
- Lightweight signal vs comment ("👍 looks good without writing 'looks good'")
- Question for design pass: does this earn its place in v1, or is it scope creep?

## Why this isn't part of review workflow

Tempting to fold "comments" into review workflow because that's where the immediate need surfaced. Wrong scope:

- Comments belong on draft content too (mid-edit collaboration before submitting for review)
- Comments belong on assets (alt-text discussion, licensing notes)
- Comments belong on publish requests (release-coordination notes)
- Comments belong on past audit events (incident postmortems)

If we ship comments inside review workflow, we'd retrofit every other surface later. Collaboration is the right umbrella; review workflow consumes it.

## Why this isn't part of audit log

Audit log is structured forensic record. Comments are unstructured human conversation. They share a timestamp + actor concept but the queries differ:

- Audit: "what writes happened in scope X between timestamps Y and Z?"
- Comments: "what's the discussion on page X?"

Different storage shape (audit is per-revision; comments are per-thread), different retention (audit has compliance retention; comments may be operator-policy retention), different access pattern (audit drawer vs inline-on-content).

Reuse where appropriate (audit records "Alice posted a comment on /home" as an audit event with `action: 'comment'`); separate primitives where the shapes differ.

## Open questions for the design pass

(These are placeholders — the design pass formalizes them.)

### Multi-instance check
- Comment storage: per-thread file? Per-comment sidecar? `.gazetta/comments/{kind}/{name}/threads/{thread-id}.json`?
- Mention dispatch: real-time (SSE push) or pull (notification poll)?
- Notification provider: pluggable (email, Slack, webhook) following the AuditProvider pattern

### Surface composition
- How do inline comments anchor to content paths that may move (component reorders)? Anchor by content-hash or by structural path?
- Cross-locale comments — comment on `/home` (en) auto-visible on `/home` (fr)? Or per-locale?
- Cross-target comments — comment on staging visible on prod? (Probably yes; comments are content metadata, not target-state.)

### Privacy and moderation
- Comment visibility — gated by `read:` capability of the underlying content
- Mention visibility leak — mentioning a viewer in a comment reveals their existence
- Moderation capability — `comment:moderate` for editing/deleting others' comments
- Right-to-be-forgotten — scrub author + mentions of scrubbed user

### Notification scope
- Email-required vs in-admin-only
- Slack / webhook / pluggable Notification Provider as Extension Surface #12
- Digest vs per-event
- Operator-default vs user-override

### State machine for comment lifecycle
- `open` / `resolved` / `archived`
- Who can resolve — author, mentioned-user, anyone with capability?
- Re-open semantics

### Composition with review workflow
- Approver leaves a comment with `state: open` — does that gate approval? (Recommend no; comments are conversation, approval is gate)
- "Approve once these comments are resolved" — interesting, but feature-creep
- Reject with a comment — comment becomes part of the rejection record (consistent with current Q1 lock)

### Composition with hooks
- `afterCommentPosted`, `afterCommentResolved`, `afterMention`
- Plugin authors can wire external systems (Linear ticket creation on comment-with-`#bug`, Slack on mention)

### Composition with offline
- Comments queued offline + replayed on reconnect (matches save replay pattern)
- Mentions in offline comments — notification fires on replay, not on offline write

### Composition with each foundational dimension
- Scale — comment count per page can grow large; pagination + sidecar shape
- Locale — per-locale or shared (open question)
- RBAC — `comment:write`, `comment:moderate`, `mention:any`, `subscribe:any`
- Audit — every comment write/edit/delete records audit event
- Plugin — Notification Provider as Extension Surface candidate

## Migration

Sites without collaboration features continue to work — collaboration is additive. Comment threads live in a reserved namespace (`.gazetta/comments/`) that runtime ignores. RBAC defaults grant `comment:write` to editor + admin roles only.

## Future directions

- **Notification Provider as Extension Surface** — pluggable email / Slack / webhook / Discord providers following the AuditProvider pattern
- **Reactions** — lightweight signals (thumbs up, eyes, etc.) on comments and content
- **Real-time comment streams** — SSE push of new comments to active viewers (composes with presence)
- **External system bridges** — GitHub Discussions, Linear, Jira tickets surfaced as comment threads via hooks
- **Translation discussion** — terminology questions per locale variant; composes with per-field translation
- **Comment templates** — saved reviewer comments ("Please add alt text" as one-click)
- **Approval-blocking comments** — opt-in mode where unresolved comments block approval (compliance archetype)
