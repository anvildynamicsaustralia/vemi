#!/usr/bin/env bash
# The one gate. Runs every check legacy's own `verify` runs (build, typecheck, lint, test) plus the
# em-dash scan, the link check, the release scan and the browser screens. Local only: nothing here
# deploys or touches a remote.
#
# It stops at the first failing stage, says which stage failed, and ends with a timing table. Only
# the quick static stages run side by side (each prints nothing until it is done, then its whole
# output appears in order); everything that boots a Worker runs alone, so a busy machine cannot
# make one suite outrun another. Nothing is skipped to save time.
set -euo pipefail
cd "$(dirname "$0")/.."

TIMES=()
CURRENT=""
STAGE_START=$SECONDS
RUN_START=$SECONDS
LOGDIR=$(mktemp -d)

close_stage() {
  if [ -n "$CURRENT" ]; then
    TIMES+=("$(printf '%5ss  %s' "$((SECONDS - STAGE_START))" "$CURRENT")")
    CURRENT=""
  fi
}

step() {
  close_stage
  CURRENT="$*"
  STAGE_START=$SECONDS
  echo
  echo "==> $*"
}

summary() {
  echo
  echo "Stage timings:"
  local line
  for line in "${TIMES[@]+"${TIMES[@]}"}"; do echo "  $line"; done
  echo "  $(printf '%5ss' "$((SECONDS - RUN_START))")  total"
}

finish() {
  local rc=$?
  trap - EXIT
  rm -rf "$LOGDIR"
  if [ $rc -ne 0 ]; then
    [ -n "$CURRENT" ] && TIMES+=("$(printf '%5ss  %s  <- FAILED' "$((SECONDS - STAGE_START))" "$CURRENT")")
    summary >&2
    echo >&2
    echo "CHECK FAILED in stage: ${CURRENT:-start-up} (exit $rc)" >&2
  fi
  exit $rc
}
trap finish EXIT

# static NAME COMMAND...: starts a quick check in the background, its output kept for later.
PIDS=()
NAMES=()
static() {
  local name=$1
  shift
  (
    set -e
    "$@"
  ) >"$LOGDIR/${#NAMES[@]}.log" 2>&1 &
  PIDS+=($!)
  NAMES+=("$name")
}

# join_static: waits for every static check, shows each one's output in the order started, and
# fails if any failed. Every one is waited for, so a failure never leaves another running.
join_static() {
  local i failed=0
  for i in "${!PIDS[@]}"; do
    if wait "${PIDS[$i]}"; then
      echo "--- ${NAMES[$i]}: ok"
      cat "$LOGDIR/$i.log"
    else
      echo "--- ${NAMES[$i]}: FAILED"
      cat "$LOGDIR/$i.log"
      CURRENT="${NAMES[$i]}"
      failed=1
    fi
  done
  PIDS=()
  NAMES=()
  [ $failed -eq 0 ] || return 1
}

release_scan() {
  bash scripts/release-scan.sh --self-test
  bash scripts/release-scan.sh
}

step "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

step "static checks together: em-dash scan, link check, typecheck, lint, release scan"
static "em-dash scan (no em-dash in a user-facing string)" node scripts/scan-em-dash.mjs
static "link check (docs links, anchors, alt text, no .works link; no network)" node scripts/check-links.mjs
static "pnpm run typecheck" pnpm run typecheck
static "pnpm run lint" pnpm run lint
static "release scan (no account ID, token, key or stray email in a tracked file)" release_scan
join_static

step "pnpm run build"
pnpm run build

step "bundle budget (the entry a first visit downloads, gzip, within 5% of the recorded figure)"
node scripts/bundle-budget.mjs

# worker.test.ts boots a real wrangler dev (esbuild bundle plus workerd). Beside every other file's
# miniflare start, that cold boot can outrun its wait, so it runs alone. Nothing else is excluded.
step "vitest run (everything except worker.test.ts)"
pnpm exec vitest run --exclude src/api/worker.test.ts

# The on-device stand-in has to agree with D1: the suites that lean hardest on the database run
# again against it. Nothing is excluded from the run above; this is a second pass, not a swap.
step "vitest run: the store suites again on the SQLite stand-in (VEMI_D1=sqlite)"
VEMI_D1=sqlite pnpm exec vitest run \
  src/api/store.test.ts src/api/isolation.test.ts src/api/ownerIndexes.test.ts \
  src/api/migrations.test.ts src/api/accountData.test.ts src/api/locked.test.ts src/api/keys.test.ts

step "worker.test.ts on its own"
pnpm exec vitest run src/api/worker.test.ts

# Every main screen in a real browser, both themes, desk and phone, against the build above. The
# browser download is a no-op once it is cached. Screenshots land in e2e/screenshots (git-ignored).
step "playwright: screens in both themes and sizes"
pnpm exec playwright install chromium
pnpm exec playwright test

close_stage
summary
echo
echo "ALL CHECKS PASSED"
