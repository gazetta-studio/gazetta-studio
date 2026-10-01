# Fix-bot lessons learned

Cross-issue patterns from reviewer verdicts + maintainer
rejections. Loaded into Agent A's prompt every run; rewritten
monthly.

## Recurring patterns

### Mutation-coverage cuts: `Mode: structural`

Dominant cut shape — 19 cycles this window across admin-api
routes + publish-rendered + publish.ts. Test-only backfill;
the 4-step revert-check does NOT apply.

- Declare `Mode: structural`; ship one commit (reviewers accept
  single-commit shape for coverage cuts).
- Fill `Runtime exercise: N/A — <specific reason>` (e.g.
  "missing-test backfill; failing tests pin coverage
  invariants on already-correct behaviour").
- Prove anti-tautology by **mutant injection**: apply each
  mutant to source, run the test, confirm it fails matching the
  predicted effect, restore. Report the concrete failure
  message per mutant.
- When the file has prior fix-bot cycles, **pick a fresh
  cluster** — scan prior PRs, target an untouched surface
  (#703, #726, #796 all layered new coverage on previously-
  fixed files). Cite the chain in the commit body.

### Honestly document equivalent / unkillable mutants

Reviewers positively cite honesty about mutants that CAN'T be
killed through test additions. Four recurring shapes:

- **Resolved earlier by a guard** — early-return rejects every
  differentiating input (#622/#687/#773 line-212).
- **Invisible through the storage abstraction** — memoryStorage
  / JSON-roundtrip erases the distinction (#712 64/76/78; #737
  235/283/309; #742 59/73/74).
- **Unreachable via HTTP** — route always supplies the input
  that would discriminate (#737 line-213; #796 408–458).
- **Single-element Zod path** — `.join('.')` ≡ `.join('')` for
  flat-schema inputs (#622/#687/#773 line-119).

Rules:

- Ship a killing test OR document why unkillable, naming the
  specific guard / caller / serialisation step.
- Put equivalence claims in `Discovered:` AND a header comment
  on the new test file when several accumulate.
- Never pad the diff with tautological tests for an equivalent
  mutant.

### Verify the reporter's diagnosis before implementing

Four cycles overrode the reporter:

- #659: suggested skip-list loop; real cause was missing barrel
  filter at discovery.
- #706: counted `provider.ts` as mutable; it's pure-interface.
- #742: claimed capability-string mutants; those target the
  `'target'` query-string.
- #745: said "inter-test leak"; race was intra-test — `Ctrl+z`
  before fill's onChange reached the undoStack.

Read source paths named in the issue; verify the causal chain
before coding. When wrong, name the real cause with file:line
evidence and fix at the correct layer.

### Flake fixes require rule-35 durability proof

Three cycles (#661, #744, #745). Pre-fix state is
nondeterministic; the 4-step revert doesn't apply.

- Run `--repeat-each=5` under `CI=true`, workers=1; report the
  concrete pass count (#745: `25/25 across 5 tests × 5`).
- If unreproducible locally (docker cold-start #744; CI-only
  pressure elsewhere), state the structural reason in `Runtime
  exercise: N/A` and cite rule 35's local-vs-CI carve-out —
  don't substitute a warm-runner rerun.
- `Mode: behavioral` for real races (#745); `Mode: structural`
  for timeout-budget widening (#661, #744).

### Mirror sibling bots symmetrically (rule 38)

Three cycles: #692 (past-PR feedback loop ported from
dead-code-watcher); #699 (comment-author filter fixed in both);
#793 (route-attempt extraction mirrored from feature-bot).

- Before implementing in `bots/{one}/`, grep `bots/**` for the
  same shape in siblings; land symmetrically in the same PR.
- Cite rule-38 in the commit body when the change spans bots.
- Where fix-bot intentionally diverges (#793 final-REJECT
  `retry-with-note` vs feature-bot's escalate), document it.

---

## Areas where Agent A succeeds

Zero maintainer rejections this window across 30+ cycles. The
five patterns above pay rent because reviewers spot-check them.
