#!/usr/bin/env bash
# Prints the exact command that exports a remote D1 database to a .sql dump in data/ (git ignores it).
# It never runs the command: Andy runs it himself. Usage: scripts/data/export-d1.sh staging|production
set -euo pipefail

case "${1:-}" in
  staging) name="vemi-staging"; envflag=" --env staging" ;;
  production) name="vemi"; envflag="" ;;
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

stamp="$(date -u +%Y%m%d-%H%M%S)"
out="data/${1}-${stamp}.sql"

echo "Run this yourself. It reads the ${1} database (${name}) and writes a dump; it changes nothing remote."
echo
echo "  mkdir -p data && pnpm exec wrangler d1 export ${name} --remote${envflag} --output ${out}"
echo
echo "Then load it into a throwaway local database with: scripts/data/load-d1.sh data/${1}-${stamp}.sql"
