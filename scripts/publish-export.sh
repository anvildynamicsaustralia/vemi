#!/usr/bin/env bash
# Public export: copies what belongs in the open-source repo into a new folder, scans it, and
# makes a fresh git repo there with one commit. It never pushes and never adds a remote.
#
#   scripts/publish-export.sh <out-dir> [commit message]     default message: "VEMI <version from package.json>"
#
# Only files git tracks are copied, so ignored local files (andy.local.json, .dev.vars, data/)
# stay behind. .works/, data/, AGENTS.md, CLAUDE.md and DEPLOY.md are left out even if tracked. The scan from release-scan.sh
# runs on the copy; any leak stops the export and the folder is removed.
set -euo pipefail

OUT=${1:-}
VERSION=$(node -p "require(process.argv[1]).version" "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/package.json")
MSG=${2:-"VEMI $VERSION"}
[ -n "$OUT" ] || { echo "usage: scripts/publish-export.sh <out-dir> [commit message]" >&2; exit 2; }
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "refusing: $OUT exists and is not empty" >&2
  exit 2
fi
# Resolve the folder before it exists, so a refusal leaves nothing behind.
PARENT=$(cd "$(dirname "$OUT")" 2>/dev/null && pwd) || { echo "refusing: the parent of $OUT does not exist" >&2; exit 2; }
OUT=$PARENT/$(basename "$OUT")
case $OUT/ in "$ROOT"/*) echo "refusing: the export folder must be outside the repo" >&2; exit 2 ;; esac
mkdir -p "$OUT"

cleanup_on_fail() { rm -rf "$OUT"; }
trap 'cleanup_on_fail' ERR

LIST=$(mktemp)
while IFS= read -r -d "" f; do
  case $f in .works/* | data/* | .claude/* | AGENTS.md | CLAUDE.md | DEPLOY.md | andy.local.json | wrangler.andy*.jsonc | .dev.vars | .dev.vars.*.local) continue ;; esac
  [ -f "$ROOT/$f" ] || continue
  printf "%s\0" "$f" >>"$LIST"
done < <(git -C "$ROOT" ls-files -z)
count=$(tr -cd "\0" <"$LIST" | wc -c | tr -d " ")
tar -C "$ROOT" --null -T "$LIST" -cf - | tar -C "$OUT" -xf -
rm -f "$LIST"

bash "$ROOT/scripts/release-scan.sh" "$OUT"

git -C "$OUT" init -q -b main
git -C "$OUT" add -A
GIT_AUTHOR_NAME=VEMI GIT_AUTHOR_EMAIL="" \
GIT_COMMITTER_NAME=VEMI GIT_COMMITTER_EMAIL="" \
  git -C "$OUT" -c commit.gpgsign=false commit -q -m "$MSG"
trap - ERR
echo "EXPORTED $count files to $OUT as one commit: $MSG (nothing pushed)"
