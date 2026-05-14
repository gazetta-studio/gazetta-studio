# Fix-bot lessons learned

This file is the bot's cross-issue memory: patterns observed across
multiple maintainer rejections + reviewer feedback. It's loaded by
Agent A's prompt on every run, near the top of the instructions.

**Maintained by `fix-bot:compact` (the monthly compactor).** Claude
reads two raw signals and rewrites this file holistically each month:

- **`skip-list.json`** — per-issue rejection memory. Each entry is
  a maintainer-rejected or bot-detected failure mode.
- **`reviewer-log.jsonl`** — every Agent B verdict (APPROVE, REJECT,
  NEEDS_HUMAN). Captures cross-issue patterns the maintainer never
  sees directly — Agent B's substantive caveats, reject→retry→approve
  sequences, loop-exhausted failure modes.

The compactor applies a strict value filter — only patterns observed
across ≥2 cases land here. Trivial first-attempt approves with "looks
good" reasoning never make it; they'd dilute the actionable patterns
below.

Git history preserves dropped lessons. They're not lost; they're
just no longer in active prompt context.

The lessons live in the body below this header. Empty until the
compactor's first run accumulates enough data.

---

(no lessons yet — bot is in its first month of operation)
