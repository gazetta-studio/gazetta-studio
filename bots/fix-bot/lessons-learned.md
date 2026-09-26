# Fix-bot lessons learned

Cross-issue patterns from reviewer verdicts + maintainer
rejections. Loaded into Agent A's prompt every run. Rewritten
monthly by `fix-bot:compact`.

---

## Recurring patterns

### Mutation-coverage cuts: `Mode: structural`

Dominant cut shape — 17 cycles this window (#622, #649, #676,
#712, #737, #742, #773, #796, #798, …). Test-only backfill; the
default 2-commit TDD shape and 4-step revert-check do NOT apply
because there is no source-side fix to sequence a failing test
against.

- Declare `Mode: structural`; ship one commit.
- Fill `Runtime exercise: N/A — <specific reason>` (e.g.
  "missing-test backfill; failing tests pin mutation-coverage
  invariants on already-correct behaviour").
- Prove anti-tautology by **mutant injection**: apply each
  target mutant to source, run the test, confirm it fails
  matching the mutant's predicted effect, restore source. Report
  the concrete failure message per mutant in the commit body.
- Reference prior fix-bot cycles on the same file (#676's
  "#311 → #567 → this run"; #726's "prior fix #649 covered
  per-child accumulator branches"; #798's "prior cycle #564") so
  reviewers see where the new gap sits.

### Honestly document equivalent / unkillable mutants

Reviewers positively cite honesty about mutants that CAN'T be
killed — equivalent under current schema/guards (#622 line 119
flat-schema `.join('.')`; #687 line 212 route-via-`from`
ternary; #773 line 212), invisible through the storage
abstraction (#712 lines 64/76/78; #742 lines 59/73/74
`buildSelector({})` empty-map path), or unreachable via HTTP
(#737 line 213 param-guard; #796 line 237 auth-prefix default).

- Ship a killing test OR document why the mutant is
  equivalent/unkillable with a specific reason (which guard
  runs first, which caller never invokes the branch, which
  serialisation step erases it).
- Put equivalence claims in `Discovered:` AND (when several
  accumulate on one file) a header comment on the new test file,
  so future cycles don't re-attempt.
- Never pad the diff with tautological tests to "cover" an
  equivalent mutant — reviewers spot this.

### Verify the reporter's diagnosis before implementing

Three cycles this window overrode the reporter:
- #659: reporter suggested skip-list feedback loop; real cause
  was missing barrel filter at discovery.
- #706: reporter counted `provider.ts` as mutable; it's
  pure-interface (zero runtime values).
- #745: reporter said "inter-test leak"; race was intra-test —
  `Ctrl+z` before fill's `onChange` reached the undoStack.

- Read the source paths named in the issue; verify the causal
  chain before coding.
- When the reporter is wrong, name the real cause with
  file:line evidence and fix at the correct layer.

### Flake fixes require rule-35 durability proof

Three cycles (#661, #744, #745). Pre-fix state is
nondeterministic; the 4-step revert doesn't apply because
"pre-fix failing" isn't a stable condition.

- Run `--repeat-each=5` under `CI=true`, workers=1; report the
  concrete pass count (#745: `25/25 across 5 tests × 5 repeats`).
- If the flake can't be reproduced locally (docker cold-start in
  #744; CI-only pressure elsewhere), state the structural reason
  in `Runtime exercise: N/A` and cite rule 35's local-vs-CI
  carve-out — don't substitute a warm-runner rerun.
- Declare `Mode: behavioral` for real races (#745), `Mode:
  structural` for timeout-budget widening (#661, #744).

### Mirror sibling bots symmetrically (rule 38)

Three cycles (#692, #699, #793). A bug OR structural
improvement in one bot exists byte-identically in a sibling;
landing one without the other rots silently.
- #692: ported dead-code-watcher's past-PR feedback loop to
  fix-bot.
- #699: fixed both bots' comment-author filter (`user.type ===
  'Bot'`) symmetrically in one PR.
- #793: mirrored feature-bot's pure `route-attempt.ts`
  extraction — structural symmetry, not a bug.

- Before implementing in `bots/{one}/`, grep `bots/**` for the
  same shape in siblings; land symmetrically in the same PR.
- Cite rule 38 in the commit body when the change spans bots.
- Where fix-bot intentionally diverges (e.g. #793's final-REJECT
  `retry-with-note` vs feature-bot's escalate), document the
  divergence + preserve current observable behaviour rather than
  silently aligning.

---

## Areas where Agent A succeeds

Skip-list is empty this window: 30+ tracked cycles, every PR
merged, zero maintainer rejections OR NEEDS_HUMAN escalations.
The five patterns above pay rent because reviewers actively
spot-check them — keeping the file terse and load-bearing.
Absence of new failure modes is itself a signal that these
patterns are correctly calibrated; a future cycle producing
new rejections will surface either a genuine drift or a
missing pattern to add.
