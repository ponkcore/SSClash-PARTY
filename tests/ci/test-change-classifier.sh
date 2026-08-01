#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
classifier="${repo_root}/scripts/classify-ci-changes.sh"

assert_scope() {
  local expected actual
  expected="$1"
  shift

  if [[ "$#" -eq 0 ]]; then
    actual="$("${classifier}")"
  else
    actual="$(printf '%s\0' "$@" | "${classifier}")"
  fi

  if [[ "${actual}" != "full=${expected}" ]]; then
    printf 'Expected full=%s, got %s\n' "${expected}" "${actual}" >&2
    exit 1
  fi
}

assert_scope false README.md PARTY.md AGENTS.md
assert_scope false docs/installer.md docs/assets/overview.png
assert_scope false .github/ISSUE_TEMPLATE/bug.yml
assert_scope false .github/PULL_REQUEST_TEMPLATE.md
assert_scope false $'docs/assets/diagram\nsecond-line.png'

assert_scope true
assert_scope true LICENSE
assert_scope true .github/workflows/build.yml
assert_scope true scripts/check-markdown-links.mjs
assert_scope true luci-app-ssclash/Makefile
assert_scope true README.md luci-app-ssclash/rootfs/etc/init.d/clash

printf 'CI change-classifier tests passed.\n'
