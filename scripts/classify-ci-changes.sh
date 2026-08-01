#!/usr/bin/env bash
set -euo pipefail

# Read NUL-delimited repository paths from standard input and emit a GitHub
# Actions output. Unknown, empty, or mixed scopes deliberately require the
# complete source and OpenWrt package matrix.

seen=0
full=false

while IFS= read -r -d '' path; do
  seen=1

  case "${path}" in
    *.md | docs/* | .github/ISSUE_TEMPLATE/* | .github/PULL_REQUEST_TEMPLATE*)
      ;;
    *)
      full=true
      ;;
  esac
done

if [[ "${seen}" -eq 0 ]]; then
  full=true
fi

printf 'full=%s\n' "${full}"
