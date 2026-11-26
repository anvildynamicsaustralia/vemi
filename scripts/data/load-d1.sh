#!/usr/bin/env bash
# Loads a .sql dump (from `wrangler d1 export`) into a fresh LOCAL D1 for this repo.
# The database lives in its own folder under data/, so the dev database in .wrangler is untouched.
# Local only: it passes --local and never --remote. Usage: scripts/data/load-d1.sh <dump.sql> [name]
set -euo pipefail

if [ $# -lt 1 ] || [ ! -f "$1" ]; then
  echo "usage: $0 <dump.sql> [name]" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
dump="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
name="${2:-$(basename "$1" .sql)}"
case "$name" in
  ""|*/*|*\\*|.*) echo "name must be a plain folder name" >&2; exit 2 ;;
esac

persist="$root/data/local-load/$name"
rm -rf "$persist"
mkdir -p "$persist"

# A D1 export writes each table followed by its rows, in creation order, so a row can name a
# table created later (project.stage_id references stage). SQLite refuses that insert even with
# deferred foreign keys, so every CREATE TABLE runs first and the rest of the dump after it.
ordered="$persist/ordered.sql"
awk '
  FNR == 1 { pass++ }
  pass == 1 && /^PRAGMA / { print; next }
  pass == 1 && /^CREATE TABLE / { inside = 1 }
  pass == 1 && inside { print; if (/[)];[[:space:]]*$/) inside = 0; next }
  pass == 2 && /^PRAGMA / { next }
  pass == 2 && /^CREATE TABLE / { skip = 1 }
  pass == 2 && skip { if (/[)];[[:space:]]*$/) skip = 0; next }
  pass == 2 { print }
' "$dump" "$dump" > "$ordered"

cd "$root"
pnpm exec wrangler d1 execute DB --local --persist-to "$persist" --file "$ordered"
rm -f "$ordered"

echo
echo "Loaded $dump into $persist"
echo "Query it: pnpm exec wrangler d1 execute DB --local --persist-to \"$persist\" --command \"select count(*) from sqlite_master\""
