# Fix-bot lessons learned

This file is the bot's cross-issue memory: patterns observed across
multiple maintainer rejections + reviewer feedback. It's loaded by
Agent A's prompt on every run, near the top of the instructions.

**Maintained by `fix-bot:compact` (the monthly compactor).** Claude
reads two raw signals and rewrites this file holistically each month:

- **`skip-list.json`** — per-issue rejection memory.
- **`reviewer-log.jsonl`** — every Agent B verdict, including the
  reject→retry→approve sequences the maintainer never sees directly.

Only patterns observed across ≥2 cases land here. Git history
preserves dropped lessons.

---

## Recurring failure modes

### Tautological tests — assertions pin observation, not contract

Agent A's first attempt repeatedly writes a regression test by
running the buggy code, observing its output, and asserting on that
exact output. The test "passes" but proves nothing — reverting the
fix doesn't break it, because the assertion captures what the code
does rather than what the fix should achieve. Agent B catches this
on review and rejects; Agent A's retry succeeds when it rewrites
the test to pin the intended contract.

**Cited verdicts:** #100 (publish duplicating items — first test
asserted on observed dedupe behaviour; retry asserted "publish must
not duplicate items"). #101 (URL encoding — first test asserted on
the produced string; retry asserted on round-trip contract).

**What Agent A should do:**

- Before writing the assertion, articulate the **intended contract**
  in one sentence ("publish must not duplicate items", "encoded URLs
  must round-trip through decode"). The assertion encodes that
  sentence, not the function's current return value.
- Self-check via revert: mentally (or actually) revert the planned
  fix and confirm the proposed test would fail. If it would still
  pass, the assertion is on observation, not contract — rewrite it.
- Per [team-preferences rule 31](../../.claude/rules/team-preferences.md),
  write the failing test first in a separate commit; confirm it
  fails against unmodified code; only then write the fix commit.
  Never weaken an assertion to make red turn green.
- When the contract is hard to articulate, that's a signal the fix
  scope or root cause isn't yet understood — pause and re-diagnose
  before writing either the test or the code.
