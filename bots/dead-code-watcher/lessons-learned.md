# dead-code-watcher — lessons learned

This file is the durable cross-finding memory the monthly compactor
maintains. Agent A reads it at the start of every per-finding
investigation; the lessons here shape its judgment alongside the
per-finding prompt's static guidance.

**Maintained by** `dead-code-watcher:compact` (see [compact.ts](compact.ts)).
The compactor rewrites this file holistically once a month from the
skip-list rejections and reviewer-log entries, keeping only the
**valuable** recurring patterns:

- **Reject → retry → approve sequences** — what did Agent A change
  between attempts that made the reviewer happy? That's a transferable
  fix pattern.
- **Approves with substantive caveats** — when Agent B said "approving
  but noticed X," X is the signal worth capturing.
- **Loop-exhausted needs-human cases** — genuine failure modes that
  ate the per-finding budget; future Agent A should recognise them
  early and SKIP with `needs-human` instead of wasting attempts.

What this file deliberately does NOT capture:

- Trivial first-attempt approves with "looks good" reasoning. No
  signal; would dilute the actionable patterns below.
- Per-finding rejection prose (that lives durably in `skip-list.json`
  + the `pastPROutcome` feedback loop).
- Static guidance that already exists in [prompts/per-finding.md](prompts/per-finding.md).

Git history preserves dropped lessons — they're not lost, just no
longer in active context for future Agent A runs.

---

## Recurring failure modes

_(Empty until the first monthly compaction produces patterns. The
compactor needs at least 3 skip-list entries OR 5 reviewer-log
entries with substantive reasoning before it surfaces anything here —
below those thresholds the signal-to-noise ratio is too low.)_
