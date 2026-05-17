# Mutation-area-picker — lessons learned

Cross-run patterns distilled from the reviewer-log. The bot reads this
file at the top of every cron and uses the lessons to calibrate its
decision-making.

## Status: v1 placeholder — no compactor shipped

The bot is autonomous v1; the compactor that would maintain this file
is **deliberately deferred** per
[`.claude/rules/design-mutation-area-picker.md`](../../.claude/rules/design-mutation-area-picker.md)
§"Memory". Reason: at the bot's weekly cadence (~52 decisions/year),
signal volume is too thin to justify a monthly compactor right now.
The runtime budget already self-compacts the working portfolio via
SWAP/REMOVE actions; this file would compact CROSS-decision patterns,
which is a different concern that earns its place when the data
accumulates.

**Until the compactor ships, this file stays empty.** The bot's prompt
still loads it (the load path is wired so adding a compactor later is
additive).

## Manual recalibration today

If you observe a pattern that should become a lesson — e.g. weights
consistently producing weak picks — edit this file by hand and commit.
The bot reads it next cron. When the compactor lands, it will rewrite
this file holistically from the reviewer-log.

## Trigger to revisit compactor design

Any one of:

- **Skip-list grows past 10 entries** with visible glob-compactable
  patterns. At that point we want generic glob rules (like
  dead-code-watcher's compactor produces), not 10+ specific entries.
- **Reviewer-log entries past 200** (the cache ceiling). We want
  bounded cache via the `pruneReviewerLog` helper already imported by
  the future compactor.
- **Calibration drift visible** — bot consistently picks weak
  candidates because heuristic weights are wrong; we want
  lessons-learned to surface the recurring pattern.

When any trigger fires, the compactor ships as ~150 LOC + a job in
`bots-compact.yml`. The design surface is unchanged; only the
implementation timing.
