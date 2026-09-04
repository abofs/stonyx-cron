#!/usr/bin/env bash
#
# Remediation for abofs/stonyx-cron#50 — rewrite the deprecation message on the
# 22 published @stonyx/cron versions that shipped `package/.git/config`.
#
# WHY THIS SCRIPT EXISTS
#   The defect is registry metadata, not code. The existing deprecation text says
#   "Please upgrade to the latest version" while the `latest` dist-tag IS one of
#   the affected versions (0.2.0). A user who obeys the notice lands back on the
#   deprecated artifact — a closed loop. This rewrites the text to point at the
#   maintained beta channel instead.
#
# WHAT THIS SCRIPT DOES NOT DO
#   It does NOT touch any dist-tag. Per the CTO decision on issue #50 (option 2
#   only), `latest` stays at 0.2.0. Advancing it is deferred to a gated
#   follow-up. There is no `npm dist-tag` call anywhere in this file.
#
# REQUIREMENTS
#   An npm ACCOUNT with publish rights on the `@stonyx` scope, authenticated
#   interactively with `npm login`. Not a token.
#
#   There is no long-lived npm credential in this org and none should be minted
#   for this. Publishing uses GitHub OIDC trusted publishing: a short-lived
#   identity, bound to one repo and one package, minted per CI job. It does not
#   exist outside a workflow run and cannot be handed to an operator.
#   (`CASCADE_PAT`, the one secret the publish workflow declares, is a GitHub PAT
#   used for cascade dispatch. It grants nothing on the npm registry.)
#
#   WHO HOLDS THIS ACCESS: every affected version across @stonyx/cron and
#   @stonyx/events is ALREADY deprecated, so `npm deprecate` has been run
#   successfully against this scope before, by someone. Whoever did that holds
#   exactly the access this script needs -- that is the person to ask.
#
#   Verify with `npm whoami` before running.
#
# USAGE
#   ./scripts/deprecation-remediation.sh --check    # read-only; verify state
#   ./scripts/deprecation-remediation.sh --apply    # perform the rewrite
#
# Re-running --apply is safe: `npm deprecate` is idempotent for identical text.

set -euo pipefail

PKG="@stonyx/cron"

# The affected set: every published version whose tarball contains at least one
# `package/.git/` entry. Verified 2026-09-04 by downloading all 142 tarballs
# published as of that measurement and running `tar tzf | grep -c '^package/\.git/'` against each.
# Result: exactly these 22 returned a non-zero count; the other 120 returned 0.
# This set is also exactly equal to the set already carrying a `deprecated`
# field, so the rewrite neither widens nor narrows the deprecation.
#
# NOTE: this list is applied version-by-version on purpose. `npm deprecate`
# takes a semver RANGE, and this set is not expressible as a clean one --
# a naive `<0.2.1-beta.20` would also sweep 0.0.1 through 0.1.0, which are
# clean and must stay undeprecated.
VERSIONS=(
  0.2.0
  0.2.1-alpha.0
  0.2.1-beta.0
  0.2.1-beta.1
  0.2.1-beta.2
  0.2.1-beta.3
  0.2.1-beta.4
  0.2.1-beta.5
  0.2.1-beta.6
  0.2.1-beta.7
  0.2.1-beta.8
  0.2.1-beta.9
  0.2.1-beta.10
  0.2.1-beta.11
  0.2.1-beta.12
  0.2.1-beta.13
  0.2.1-beta.14
  0.2.1-beta.15
  0.2.1-beta.16
  0.2.1-beta.17
  0.2.1-beta.18
  0.2.1-beta.19
)

# The replacement text. Points at the CHANNEL rather than a frozen version
# string: a frozen string goes stale on the next beta bump and would need
# re-applying across 22 versions forever. The parenthetical resolution is
# descriptive of a point in time and is what makes the message auditable.
read -r -d '' MESSAGE <<'EOM' || true
This version shipped package/.git/config in the published tarball and must not be used. The `latest` tag is NOT a safe upgrade target - it also points at an affected version. Install from the maintained beta channel instead: npm install @stonyx/cron@beta (resolves to 0.2.1-beta.95 as of 2026-09-03).
EOM

usage() { echo "usage: $0 --check | --apply" >&2; exit 2; }

require_auth() {
  if ! npm whoami >/dev/null 2>&1; then
    echo "FATAL: not authenticated to the npm registry." >&2
    echo "       \`npm deprecate\` needs an npm ACCOUNT with publish rights on the" >&2
    echo "       @stonyx scope. Run \`npm login\` and retry." >&2
    echo "       There is no stored npm token in this org and none should be created:" >&2
    echo "       publishing uses OIDC trusted publishing (short-lived, repo- and" >&2
    echo "       package-bound, minted per CI job). Every affected version is already" >&2
    echo "       deprecated, so whoever ran \`npm deprecate\` on this scope before" >&2
    echo "       holds the access this needs." >&2
    exit 1
  fi
  echo "authenticated as: $(npm whoami)"
}

do_apply() {
  require_auth
  echo "applying deprecation text to ${#VERSIONS[@]} versions of ${PKG}"
  for v in "${VERSIONS[@]}"; do
    printf '  %-20s ... ' "$v"
    npm deprecate "${PKG}@${v}" "$MESSAGE"
    echo 'ok'
  done
  echo "done. now run: $0 --check"
}

do_check() {
  local fail=0

  # AC2 control first. If the control does not go red, the check is inert and
  # every result below it is void.
  echo "== control: the check must be capable of failing =="
  local ctl
  ctl=$(npm pack "${PKG}@0.2.0" --silent 2>/dev/null)
  local ctl_n
  ctl_n=$(tar tzf "$ctl" | grep -c '^package/\.git/' || true)
  rm -f "$ctl"
  echo "   ${PKG}@0.2.0 package/.git/ entries: ${ctl_n} (expect >=1)"
  if [ "$ctl_n" -lt 1 ]; then
    echo "   FAIL: control returned 0 - the scan is inert, results below are void"
    return 1
  fi
  echo "   control is live"

  # AC2: the named target resolves to something clean.
  echo "== AC2: named target is clean =="
  local beta
  beta=$(npm view "${PKG}@beta" version)
  echo "   ${PKG}@beta resolves to ${beta}"
  for v in "${VERSIONS[@]}"; do
    if [ "$v" = "$beta" ]; then
      echo "   FAIL: beta resolves into the affected set"
      fail=1
    fi
  done
  local tgz n
  tgz=$(npm pack "${PKG}@${beta}" --silent 2>/dev/null)
  n=$(tar tzf "$tgz" | grep -c '^package/\.git/' || true)
  rm -f "$tgz"
  echo "   ${beta} package/.git/ entries: ${n} (expect 0)"
  [ "$n" -eq 0 ] || { echo "   FAIL"; fail=1; }

  # AC(refined)1: the self-reference is gone from all 22.
  echo "== the self-defeating text is gone from all ${#VERSIONS[@]} versions =="
  for v in "${VERSIONS[@]}"; do
    local msg
    msg=$(npm view "${PKG}@${v}" deprecated 2>/dev/null || true)
    if [ -z "$msg" ]; then
      echo "   FAIL ${v}: no deprecation message at all"
      fail=1
    elif [[ "$msg" == *"the latest version"* ]]; then
      echo "   FAIL ${v}: still says 'the latest version'"
      fail=1
    elif [[ "$msg" != *"${PKG}@beta"* ]]; then
      echo "   FAIL ${v}: does not name ${PKG}@beta"
      fail=1
    fi
  done
  [ "$fail" -eq 0 ] && echo "   all ${#VERSIONS[@]} carry the corrected text"

  # AC4: latest was deliberately NOT moved.
  echo "== AC4: latest was deliberately not moved =="
  local latest
  latest=$(npm view "${PKG}" dist-tags.latest)
  echo "   latest = ${latest} (expect 0.2.0)"
  [ "$latest" = "0.2.0" ] || { echo "   FAIL: latest moved - option 1 was executed out of scope"; fail=1; }

  # AC5: no collateral deprecation.
  echo "== AC5: no collateral deprecation =="
  local count
  count=$(curl -sL "https://registry.npmjs.org/@stonyx%2Fcron" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(Object.keys(p.versions).filter(v=>p.versions[v].deprecated!==undefined).length)})')
  echo "   deprecated version count = ${count} (expect ${#VERSIONS[@]})"
  [ "$count" -eq "${#VERSIONS[@]}" ] || { echo "   FAIL: deprecation set changed size - range was over-broad"; fail=1; }

  echo
  [ "$fail" -eq 0 ] && echo "ALL CHECKS PASS" || echo "CHECKS FAILED"
  return "$fail"
}

[ $# -eq 1 ] || usage
case "$1" in
  --check) do_check ;;
  --apply) do_apply ;;
  *) usage ;;
esac
