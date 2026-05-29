<!--
  Feature-bot per-cut prompt — placeholder for Cut 1.

  The full Agent A prompt body lands in Cut 3 (generator-critic loop
  wiring) per design-feature-bot.md "Cut sequence". This file is a
  placeholder so Cut 3 has a foundation to extend; the placeholder
  shape preserves the Q5 lock so future readers see the intended
  structure even before the body lands.

  Q5 lock (design-feature-bot.md): the orchestrator does NOT inline
  the design doc in Agent A's prompt. Instead the prompt names the
  design doc path (derived from the cut sub-issue's **Feature**:
  field → .claude/rules/design-{feature}.md) and instructs Agent A
  to read it before implementing.
-->

(prompt body lands in Cut 3)

Read these in this order BEFORE implementing:

1. The cut sub-issue body (provided below by the orchestrator).
2. The design doc at `.claude/rules/design-{feature}.md` — pay
   special attention to Scope, Locked decisions, Foundational
   checks, Distinctive choices.
3. Any companion docs the design doc references (typically other
   `.claude/rules/design-*.md` or `docs/adr/*.md`).
4. The implementation files listed or implied by the cut spec.

Only AFTER reading 1-3 do you begin writing code. The design doc's
Locked decisions are NOT negotiable — implement to match them.
