#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "$0")/../.." && pwd)
helper="$repository_root/luci-app-ssclash/rootfs/usr/libexec/ssclash-party-update"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

fail() {
    echo "updater test failed: $*" >&2
    exit 1
}

state_dir="$temporary/state"
version_file="$temporary/VERSION"
fake_installer="$temporary/installer"

printf '%s\n' '4.7.0-party.8' > "$version_file"

cat > "$fake_installer" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command=${1:-}
current=$(sed -n '1p' "$SSCLASH_PARTY_VERSION_FILE")
if [[ ${SSCLASH_PARTY_FAKE_FAIL:-0} == 1 ]]; then
    echo 'private fixture detail that must never enter updater status'
    exit 1
fi

case "$command" in
    check)
        case "$current" in
            4.7.0-party.9) relation=up-to-date ;;
            4.7.0-party.10) relation=installed-newer ;;
            *) relation=update-available ;;
        esac
        printf 'SSCLASH_PARTY_UPDATE|%s|4.7.0-party.9|%s\n' "$current" "$relation"
        ;;
    upgrade)
        printf '%s\n' 'package manager fixture output'
        printf '%s\n' '4.7.0-party.9' > "$SSCLASH_PARTY_VERSION_FILE"
        ;;
    *) exit 2 ;;
esac
EOF
chmod +x "$fake_installer"

helper_environment=(
    env
    "SSCLASH_PARTY_UPDATE_STATE_DIR=$state_dir"
    "SSCLASH_PARTY_VERSION_FILE=$version_file"
    "SSCLASH_PARTY_INSTALLER=$fake_installer"
    "SSCLASH_PARTY_UPDATE_SELF=$helper"
)

wait_for_terminal_status() {
    local output phase
    for _attempt in {1..100}; do
        output=$("${helper_environment[@]}" "$helper" status)
        phase=$(jq -r '.phase' <<<"$output")
        case "$phase" in
            checking|queued|updating) sleep 0.05 ;;
            *) printf '%s\n' "$output"; return 0 ;;
        esac
    done
    fail 'background updater operation timed out'
}

output=$("${helper_environment[@]}" "$helper" status)
jq -e '.phase == "not_checked" and .installed == "4.7.0-party.8"' <<<"$output" >/dev/null ||
    fail 'initial status is wrong'

"${helper_environment[@]}" "$helper" check >/dev/null
output=$(wait_for_terminal_status)
jq -e '
    .phase == "update_available" and
    .installed == "4.7.0-party.8" and
    .latest == "4.7.0-party.9"
' <<<"$output" >/dev/null || fail 'stable update was not detected'

[[ $(stat -c '%a' "$state_dir/update.log") == 600 ]] || fail 'update log is not private'
if grep -Fq 'private fixture detail' <<<"$output"; then
    fail 'private installer output leaked into status JSON'
fi

"${helper_environment[@]}" "$helper" start >/dev/null
output=$(wait_for_terminal_status)
jq -e '.phase == "success" and .installed == "4.7.0-party.9"' <<<"$output" >/dev/null ||
    fail 'background update did not finish successfully'

"${helper_environment[@]}" "$helper" check >/dev/null
output=$(wait_for_terminal_status)
jq -e '.phase == "up_to_date" and .latest == "4.7.0-party.9"' <<<"$output" >/dev/null ||
    fail 'updated installation was not reported as current'

printf '%s\n' '4.7.0-party.10' > "$version_file"
output=$("${helper_environment[@]}" "$helper" status)
jq -e '.phase == "not_checked" and .installed == "4.7.0-party.10" and .latest == ""' \
    <<<"$output" >/dev/null || fail 'manual package change left stale updater state'

"${helper_environment[@]}" "$helper" check >/dev/null
output=$(wait_for_terminal_status)
jq -e '.phase == "ahead" and .installed == "4.7.0-party.10"' <<<"$output" >/dev/null ||
    fail 'newer installed version was not protected from downgrade'

"${helper_environment[@]}" SSCLASH_PARTY_FAKE_FAIL=1 "$helper" check >/dev/null
output=$(wait_for_terminal_status)
jq -e '.phase == "check_failed"' <<<"$output" >/dev/null ||
    fail 'failed check did not return a safe status'
if grep -Fq 'private fixture detail' <<<"$output"; then
    fail 'failed installer output leaked into status JSON'
fi

echo 'Updater tests passed.'
