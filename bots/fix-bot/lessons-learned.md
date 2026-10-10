# Fix-bot lessons learned

Cross-issue patterns from reviewer verdicts + maintainer
rejections. Loaded into Agent A's prompt every run; rewritten
monthly.

## Recurring patterns

### Mutation-coverage cuts: `Mode: structural`

Dominant cut shape — 21+ cycles across admin-api routes +
publish-rendered + publish.ts. Test-only backfill; the 4-step
revert-check does NOT apply.

- Declare `Mode: structural`; ship **one commit** — reviewers
  routinely approve single-commit shape (no source-side fix to
  sequence a failing test against).
- Fill `Runtime exercise: N/A — <specific reason>` (e.g.
  "failing tests pin coverage invariants on already-correct
  behaviour").
- Prove anti-tautology by **mutant injection**: apply each
  mutant to source, run the test, confirm failure matches the
  predicted effect, restore. Report the concrete failure
  message per mutant in the commit body.
- On files with prior fix-bot cycles, **pick a fresh cluster**
  — scan prior PRs, target untouched surface (#703, #726,
  #796, #813). Cite the chain.

### Honestly document equivalent / unkillable mutants

Reviewers positively cite honesty about mutants that CAN'T be
killed through test additions. Four shapes:

- **Resolved earlier by a guard** — early-return rejects every
  differentiating input (#622/#687/#773 line-212; #798).
- **Invisible through the storage abstraction** —
  memoryStorage / JSON-roundtrip erases distinction (#712
  64/76/78; #737 235/283/309; #742 59/73/74; #813 283/348).
- **Unreachable via HTTP** — route always supplies the input
  that would discriminate (#737 line-213; #796 408–458;
  #742 86/102/146).
- **Single-element Zod path** — `.join('.')` ≡ `.join('')` for
  flat-schema inputs (#622/#687/#773 line-119).

Rules: ship a killing test OR document why unkillable, naming
the specific guard / caller / serialisation step. Put
equivalence claims in `Discovered:` AND a header comment on
the new test file when several accumulate (#798, #811, #813).
Never pad the diff with tautological tests.

### Verify the reporter's diagnosis before implementing

Four cycles overrode the reporter:

- #659: suggested skip-list loop; real cause was missing
  barrel filter at discovery.
- #706: counted `provider.ts` as mutable; it's pure-interface.
- #742: claimed capability-string mutants; those target the
  `'target'` query-string.
- #745: said "inter-test leak"; race was intra-test — `Ctrl+z`
  before fill's onChange reached the undoStack.

Read source paths named in the issue; verify the causal chain
before coding. Name the real cause with file:line evidence and
fix at the correct layer (#659/#706 fix at discovery
pre-filter, not post-hoc scoring).

### Flake fixes require rule-35 durability proof

Three cycles (#661, #744, #745). Pre-fix state is
nondeterministic; the 4-step revert doesn't apply.

- Run `--repeat-each=5` under `CI=true`, workers=1; report the
  concrete pass count (#745: 25/25 across 5 tests × 5).
- If unreproducible locally (docker cold-start #744; CI-only
  pressure elsewhere), state the structural reason in `Runtime
  exercise: N/A` and cite rule 35's local-vs-CI carve-out.
- `Mode: behavioral` for real races (#745); `Mode: structural`
  for timeout-budget widening (#661, #744).

### Mirror sibling bots — respect intentional divergence (rule 38)

Four cycles: #692 (past-PR loop ported from dead-code-watcher);
#699 (comment-author filter fixed in both); #793 (route-attempt
mirrored from feature-bot); #805 (brace-expansion deliberately
NOT ported).

- Before implementing in `bots/{one}/`, grep `bots/**` for the
  same shape in siblings; land symmetrically in the same PR.
- Cite rule-38 in the commit body when change spans bots.
- **Respect documented divergence**: if a sibling's docstring
  explicitly states a behavior is intentionally different
  (#805, #793), do NOT silently port — name the divergence
  and skip the sibling edit.

---

## Agent A: zero rejections, 35+ cycles

The five patterns above pay rent — reviewers spot-check them
every PR.
