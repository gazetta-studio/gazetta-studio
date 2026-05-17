# review-bot lessons learned

Cross-candidate patterns the monthly compactor distills from
`reviewer-log.jsonl`. Empty at scaffold time; the compactor rewrites
this holistically once the bot has produced enough Agent B verdicts
to surface patterns.

Format intentionally loose — the compactor's prompt owns the shape.
Patterns to expect once data accumulates:

- Common candidate-types that maintainers consistently reject (→ rule
  candidates for the skip-list).
- Areas where Agent A reliably produces stuck-comments (→ scoring
  weight for Phase 0).
- Architecture/security findings that recur across candidates (→ hints
  for the per-candidate Agent A prompt).

Loaded into Agent A's prompt every run.
