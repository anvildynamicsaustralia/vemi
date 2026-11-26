#!/usr/bin/env bash
# Prints the steps of the Time Travel drill on staging. It never runs any of them: Andy
# runs each step himself. Usage: scripts/data/restore-drill.sh
set -euo pipefail

cfg="--config wrangler.andy.jsonc"
db="vemi-staging"

echo "Time Travel drill, STAGING only (${db}). Run each step yourself; this script runs none."
echo "Never run this against production."
echo
echo "1. Note a restore point (a unix timestamp in seconds) and keep it:"
echo "     date +%s"
echo "   Optional, the current bookmark: pnpm exec wrangler d1 time-travel info ${db} --env staging ${cfg}"
echo
echo "2. Export staging so you can compare, then make changes in the staging app"
echo "   (add two tasks, rename a project):"
echo "     mkdir -p data && pnpm exec wrangler d1 export ${db} --remote --env staging ${cfg} --output data/before-drill.sql"
echo
echo "3. Restore to the timestamp from step 1 (this overwrites staging in place):"
echo "     pnpm exec wrangler d1 time-travel restore ${db} --timestamp=<unix from step 1> --env staging ${cfg}"
echo
echo "4. Confirm the changes are gone: the two tasks are missing and the project has its old name."
echo "   A wrong answer is a change still there: stop and tell the next session."
