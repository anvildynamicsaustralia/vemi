#!/usr/bin/env bash
# Release scan: fails if a tracked file holds something that must not ship in an open-source repo.
#
#   scripts/release-scan.sh              scan this repo
#   scripts/release-scan.sh <dir>        scan another tree (every file under it)
#   scripts/release-scan.sh --self-test  plant one of each leak in a temp tree and see all caught
#
# Looks for: a Cloudflare account ID (32 hex), a D1 database ID (UUID), an API token shape, a
# private key block (an all-zero-prefix UUID is an obvious test fixture, not a database ID), a .dev.vars file, and any email address not named in scripts/release-scan.allow.
# The root .infisical.json may hold a UUID: it is the Infisical project ID, which names the vault
# and opens nothing without a login to it. A UUID anywhere else, a nested copy included, is caught.
# Skips .works/ and data/. In a git repo it reads only tracked files, so git-ignored local files
# are never looked at. Local only: nothing here touches a network or a remote.
set -euo pipefail

HEX32='(^|[^0-9A-Za-z])[0-9a-fA-F]{32}($|[^0-9A-Za-z])'
UUID='(^|[^0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}($|[^0-9A-Za-z])'
TOKEN='(cfut_|cfk_|cfat_)[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|[Bb]earer[ ]+[A-Za-z0-9_-]{40,}|(token|secret|api[_-]?key|password)[A-Za-z_]*["'"'"']?[ ]*[:=][ ]*["'"'"'][A-Za-z0-9_+/=-]{32,}["'"'"']'
KEYBLOCK='-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY'
EMAIL='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'

# where_only keeps "file:line" from `grep -n -o` output and drops the matched text, so a leak is
# located but its value is never printed (scan output lands in terminals and CI logs).
where_only() { sed 's/^\([^:]*:[0-9]*\):.*/\1/'; }

# scan <root>: prints one line per leak, returns 1 if there was any.
scan() {
  local root=$1 allow found=0 list
  allow="$root/scripts/release-scan.allow"
  list=$(mktemp)
  if [ "$(git -C "$root" rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ] && [ -z "$(git -C "$root" rev-parse --show-prefix 2>/dev/null)" ]; then
    git -C "$root" ls-files -z >"$list"
  else
    (cd "$root" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -print0 | sed -z 's|^\./||') >"$list"
  fi
  # Drop .works/ and data/, and anything git lists but the working tree no longer has.
  local files=() f
  while IFS= read -r -d '' f; do
    case $f in .works/* | data/*) continue ;; esac
    [ -f "$root/$f" ] && files+=("$f")
  done <"$list"
  rm -f "$list"

  for f in "${files[@]}"; do
    case ${f##*/} in
      .dev.vars | .dev.vars.*.local) echo "LEAK .dev.vars file: $f"; found=1 ;;
    esac
  done

  # Allowed addresses: "address | reason" per line; "*@domain" allows a whole reserved test domain.
  local -a allowed=()
  if [ -f "$allow" ]; then
    local line addr reason
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%$'\r'}
      case $line in '' | '#'*) continue ;; esac
      addr=$(echo "${line%%|*}" | tr -d ' ' | tr 'A-Z' 'a-z')
      reason=$(echo "${line#*|}" | sed 's/^ *//')
      if [ "$line" = "$addr" ] || [ -z "$reason" ]; then
        echo "LEAK allow list line has no reason: $line"; found=1; continue
      fi
      allowed+=("$addr")
    done <"$allow"
  fi

  [ ${#files[@]} -eq 0 ] && return $found
  local out
  out=$(cd "$root" && printf '%s\0' "${files[@]}" | xargs -0 grep -H -I -n -o -E "$HEX32" 2>/dev/null | where_only | sed 's/^/LEAK Cloudflare account ID (32 hex): /' || true)
  [ -n "$out" ] && { echo "$out"; found=1; }
  out=$(cd "$root" && printf '%s\0' "${files[@]}" | xargs -0 grep -H -I -n -o -E "$UUID" 2>/dev/null | grep -v -E "[^0-9A-Za-z]00000000-" | grep -v -E '^\.infisical\.json:[0-9]+:' | where_only | sed 's/^/LEAK D1 database ID (UUID): /' || true)
  [ -n "$out" ] && { echo "$out"; found=1; }
  out=$(cd "$root" && printf '%s\0' "${files[@]}" | xargs -0 grep -H -I -n -o -E "$TOKEN" 2>/dev/null | where_only | sed 's/^/LEAK API token shape: /' || true)
  [ -n "$out" ] && { echo "$out"; found=1; }
  out=$(cd "$root" && printf '%s\0' "${files[@]}" | xargs -0 grep -H -I -n -o -E -e "$KEYBLOCK" 2>/dev/null | where_only | sed 's/^/LEAK private key block: /' || true)
  [ -n "$out" ] && { echo "$out"; found=1; }

  local hit file rest addr_found a ok
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    file=${hit%%:*}; rest=${hit#*:}; rest=${rest#*:}
    addr_found=$(echo "$rest" | tr 'A-Z' 'a-z')
    ok=0
    for a in "${allowed[@]+"${allowed[@]}"}"; do
      case $a in
        '*@'*) [ "${addr_found#*@}" = "${a#*@}" ] && ok=1 ;;
        *) [ "$addr_found" = "$a" ] && ok=1 ;;
      esac
    done
    [ $ok -eq 1 ] || { echo "LEAK email not on the allow list: $hit"; found=1; }
  done < <(cd "$root" && printf '%s\0' "${files[@]}" | xargs -0 grep -H -I -n -o -E "$EMAIL" 2>/dev/null || true)

  return $found
}

# Build a hex string of n chars (no literal leak shape sits in this file).
hexn() { local s=""; while [ ${#s} -lt "$1" ]; do s="${s}a1b2c3d4"; done; echo "${s:0:$1}"; }

tmp=""
self_test() {
  local name rc fails=0
  tmp=$(mktemp -d)
  trap 'rm -rf "${tmp:-}"' EXIT
  plant() { # plant <name> <file> <content>
    local d="$tmp/$1"
    mkdir -p "$d/$(dirname "$2")" "$d/scripts"
    printf '%s\n' "$3" >"$d/$2"
    printf '%s\n' 'allowed@example.test | self-test address' >"$d/scripts/release-scan.allow"
  }
  expect_caught() {
    set +e; scan "$tmp/$1" >"$tmp/$1.out" 2>&1; rc=$?; set -e
    if [ $rc -ne 0 ]; then echo "  caught: $1"; else echo "  MISSED: $1"; fails=1; fi
    # A leak is reported by place only: the planted value must never reach the output.
    if grep -q -E "a1b2c3d4|cfut_|PRIVATE KEY" "$tmp/$1.out"; then echo "  PRINTED THE VALUE: $1"; fails=1; fi
  }
  plant account a.txt "account_id = \"$(hexn 32)\""
  plant d1 b.txt "database_id = \"$(hexn 8)-$(hexn 4)-$(hexn 4)-$(hexn 4)-$(hexn 12)\""
  plant token c.txt "key cfut_$(hexn 40)"
  plant pem d.txt "-----BEGIN ""RSA PRIVATE KEY-----"
  plant devvars .dev.vars "X=1"
  plant email e.txt "mail someone@real""domain.com please"
  plant ok f.txt "mail allowed@example.test please"
  plant vault .infisical.json "{ \"workspaceId\": \"$(hexn 8)-$(hexn 4)-$(hexn 4)-$(hexn 4)-$(hexn 12)\" }"
  plant nested sub/.infisical.json "{ \"workspaceId\": \"$(hexn 8)-$(hexn 4)-$(hexn 4)-$(hexn 4)-$(hexn 12)\" }"
  for name in account d1 token pem devvars email nested; do expect_caught "$name"; done
  set +e; scan "$tmp/ok" >/dev/null 2>&1; rc=$?; set -e
  if [ $rc -eq 0 ]; then echo "  passed: allowed address"; else echo "  WRONGLY CAUGHT: allowed address"; fails=1; fi
  set +e; scan "$tmp/vault" >/dev/null 2>&1; rc=$?; set -e
  if [ $rc -eq 0 ]; then echo "  passed: root .infisical.json project ID"; else echo "  WRONGLY CAUGHT: root .infisical.json project ID"; fails=1; fi
  if [ $fails -eq 0 ]; then echo "SELF-TEST PASSED"; else echo "SELF-TEST FAILED"; return 1; fi
}

main() {
  if [ "${1:-}" = "--self-test" ]; then self_test; return; fi
  local root=${1:-"$(cd "$(dirname "$0")/.." && pwd)"}
  if scan "$root"; then
    echo "release scan clean"
  else
    echo "release scan FAILED" >&2
    return 1
  fi
}

main "$@"
