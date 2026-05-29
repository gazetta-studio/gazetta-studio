# Feature-bot lessons learned

Lessons learned will be distilled by a future monthly compactor from
`bots/feature-bot/reviewer-log.jsonl` entries.

Deliberately deferred in v1 (per `design-feature-bot.md` "Memory"
section and Q7 lock): at feature-bot's expected cadence of ~52
decisions/year, signal volume is too thin to justify a compactor.
The portfolio self-compacts via SKIP / NEEDS_HUMAN entries on each
cron; what a compactor WOULD do — distilling cross-decision patterns
into prose — earns its place when skip-list growth or reviewer-log
volume crosses concrete thresholds (mirrors mutation-area-picker's
deferred-compactor rationale).

Loaded into Agent A's prompt each run by `index.ts` once Cut 3
ships the generator-critic loop. Until then, this file is an empty
placeholder — Agent A simply sees zero lessons.
