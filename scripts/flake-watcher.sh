#!/usr/bin/env bash
# flake-watcher.sh — daily CI flake detection.
#
# Strategy: rerun-then-passed. A workflow run with `run_attempt >= 2` and final
# conclusion `success` means an earlier attempt failed on the SAME SHA and
# someone hit "Re-run" and it passed. This is the strongest possible flake
# signal — same code, opposite outcome, in the same workflow.
#
# Why not "two distinct CI runs with same SHA": the GitHub Actions API
# represents reruns as additional attempts on the SAME run ID, not as new
# runs. Looking for two distinct run IDs with the same SHA returns
# cross-workflow noise (CI failure + Deploy success on the same commit is
# common and not a flake).
#
# When a flake is found, hand the FAILED attempt to Claude Code (claude -p)
# with the prompt in flake-watcher-prompt.md. Claude reads the failure logs,
# searches existing open issues for a match, and either comments on the
# existing issue or files a new one following the conventions established
# in #268.
#
# Run locally: scripts/flake-watcher.sh
# Run in CI:   .github/workflows/flake-watcher.yml (daily cron)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOOKBACK_HOURS="${LOOKBACK_HOURS:-48}"
WORKFLOW_NAME="${WORKFLOW_NAME:-CI}"
PROMPT_FILE="$REPO_ROOT/scripts/flake-watcher-prompt.md"
DRY_RUN="${DRY_RUN:-0}"  # 1 = list candidates only, don't invoke Claude

# Resolve owner/repo + workflow id once. The REST API needs both; gh's CLI
# helpers don't expose attempt-level data directly.
owner_repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
workflow_id="$(gh api "repos/$owner_repo/actions/workflows" \
  --jq ".workflows[] | select(.name == \"$WORKFLOW_NAME\") | .id")"

# ISO timestamp `LOOKBACK_HOURS` ago. macOS and GNU date take different flags;
# try GNU first, fall back to BSD.
since="$(date -u -d "${LOOKBACK_HOURS} hours ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
       || date -u -v-"${LOOKBACK_HOURS}"H +%Y-%m-%dT%H:%M:%SZ)"

echo "Flake watcher: scanning $WORKFLOW_NAME (workflow id $workflow_id) runs since $since"

# Find runs with attempt >= 2 in the window. Attempt count > 1 alone IS the
# flake signal — a rerun only happens after a failed attempt. The final
# conclusion can be either: success means "passed on rerun" (classic flake),
# failure means "still flaking after rerun" (worse flake). Both warrant
# investigation.
flaky_runs="$(gh api "repos/$owner_repo/actions/workflows/$workflow_id/runs?per_page=100&created=>$since" \
  --jq ".workflow_runs[]
        | select(.run_attempt >= 2)
        | \"\(.id) \(.head_sha[0:8]) \(.conclusion) attempt=\(.run_attempt)\"")"

if [[ -z "$flaky_runs" ]]; then
  echo "No flakes found in last ${LOOKBACK_HOURS}h. CI is healthy."
  exit 0
fi

echo "Flake candidates (run_id sha conclusion attempt):"
echo "$flaky_runs" | sed 's/^/  /'

# Extract just the run IDs to investigate.
failed_runs=()
while IFS= read -r line; do
  [[ -n "$line" ]] && failed_runs+=("${line%% *}")
done <<< "$flaky_runs"

echo "Investigating ${#failed_runs[@]} flaky run(s)."

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1 — exiting before invoking Claude."
  exit 0
fi

# Hand each failed run to Claude. The prompt does the work:
# - Reads the run's failed-job logs via `gh run view --log-failed`
# - Extracts test names + error excerpts
# - Searches existing open issues by test path
# - Either comments on the matching issue (with dedup against the run ID) or
#   files a new one following the established issue templates
for run_id in "${failed_runs[@]}"; do
  echo ""
  echo "=== Investigating run $run_id ==="

  prompt="$(cat "$PROMPT_FILE")
RUN_ID=$run_id
LOOKBACK_HOURS=$LOOKBACK_HOURS"

  # claude -p runs headless. Flag rationale:
  #   --print               : non-interactive, exit after response
  #   --allowedTools Bash   : Claude only needs gh CLI; restrict everything else
  #   --dangerously-skip-permissions : no human in CI to approve tool calls;
  #                           --allowedTools is the safety boundary
  #
  # Auth: CLAUDE_CODE_OAUTH_TOKEN env var (set in the workflow). Do NOT pass
  # --bare here — it explicitly disables OAuth token reading per the CLI docs.
  claude \
    --print \
    --allowedTools Bash \
    --dangerously-skip-permissions \
    "$prompt" || {
      # Don't let one failed investigation kill the whole job. Log and move on.
      echo "Warning: investigation of run $run_id failed; continuing."
    }
done

echo ""
echo "Flake watcher complete."
