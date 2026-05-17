# Mutation-area-picker — lessons learned

Cross-run patterns the monthly compactor surfaces from the reviewer-log
into Agent A's prompt. The bot reads this file at the top of every cron
run and uses the lessons to calibrate its decision-making.

**Empty until the first monthly compactor run.** Compactor needs at least
4 weekly runs of reviewer-log signal before it produces lessons; below
that threshold the signal-to-noise ratio is too low.

What the compactor surfaces here:

- **Heuristic-weight calibration.** "AI-pairing density consistently
  ranked first but those modules' post-mutation kill ratios stayed
  under 0.6. Consider lowering weight from 0.30 to 0.20."
- **Eviction patterns.** "Modules under `src/admin-api/routes/` reached
  kill ratio 0.85 within 6 weeks consistently. Worth tightening the
  4-week sustainment to 3 weeks for routes specifically?"
- **Recurring rejection themes.** "Last 3 maintainer rejections all
  cited 'pure type module — nothing to mutate.' Add a kind-detection
  pre-filter."

What the compactor does NOT surface here:

- Per-module rejection prose (that lives in skip-list.json's
  reasonNote field; durable per-instance memory)
- One-off observations from a single PR (wait for the pattern to
  recur before promoting to a lesson)
- Anything the bot's prompt already says (no duplication)
