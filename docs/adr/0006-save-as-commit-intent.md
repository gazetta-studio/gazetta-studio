# Save means "commit intent" — works online or offline

When the Author clicks Save in the Gazetta admin, the semantic is "I'm ready to commit this version" — not "send to the server right now." Save works identically online and offline. The system handles delivery; the Author has expressed intent. Online: save attempts immediately and either succeeds or fails. Offline: save enters the Save queue and replays on reconnect with `If-Match` etag for conflict detection. Both paths produce an audit event recording the Author's intent.

We picked this over "Save disabled while offline" because the alternative treats save as a network operation rather than a logical commitment. Disabling save offline would force the Author to remember to come back online to commit work — a UX hostile to mobile editing, transient connectivity (commercial Wi-Fi, VPN reconnects), and offline-first workflows. The "save as send to server" reading is structurally too literal: pending edits already ARE saved locally; the question is just whether to dispatch to the server. The trade-off accepted: rare conflict-on-replay surfaces (handled per `design-offline.md` Q3) in exchange for unbroken Author flow.

The corollary: Pending edits and the Save queue are distinct concepts. Pending edits = "I'm working; haven't committed yet." Save queue = "I committed; delivery's pending." Authors navigate freely between Pages with accumulated pending edits across many items; explicit Save click moves edits from Pending into either immediate-delivery (online) or the Save queue (offline). The audit event records the moment of commit, not the moment of delivery.

## Consequences

The Save UI affordance is identical online and offline (same button, same "Saved" feedback after click). The cloud-with-slash icon distinguishes "saved locally, not yet delivered" from "fully synced" — visible only when relevant per the Krug-aligned "absence is a state" principle ([team-preferences rule 23](../../.claude/rules/team-preferences.md)).

The audit log records the Author's commit-intent at queue time (`metadata.queuedAt`) plus the eventual delivery time (`metadata.replayedAt`). Forensic queries reconstruct "Alice committed at 14:23; replay landed at 18:45 after offline session" — full chronology preserved.

Conflict handling on replay (per `design-offline.md` Q3) surfaces a diff with two actions: Show diff and Discard. There is no "Save anyway (overwrite)" button — Authors who want to overwrite manually layer their changes onto the current state. This matches Linear / Notion / Figma — collaborative tools that ship offline-first don't expose force-overwrite affordances.

Audit `outcome` extends with closed-enum values for replay-time states (`failed-render`, `timeout`, `hook-cancelled`); see `design-audit.md` Q1 for the full enum. The save event from queue replay carries the same `action` as a normal save plus `metadata.replayed: true`.

Cross-cutting: this decision shapes `design-offline.md` (the queue + replay machinery), `design-audit.md` (the replay metadata), `design-collaboration.md` (comments queue + replay the same way), and `design-review-workflow.md` (review-state transitions also follow commit-intent semantics).
