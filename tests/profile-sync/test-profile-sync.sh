#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_dir="$repo_root/tests/profile-sync/fixtures"
helper="$repo_root/luci-app-ssclash/rootfs/usr/libexec/ssclash-profile-sync"
template_dir="$repo_root/luci-app-ssclash/rootfs/usr/share/ssclash-party/templates"
version_file="$repo_root/luci-app-ssclash/rootfs/usr/share/ssclash-party/VERSION"
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT

merger="$temporary_root/ssclash-profile-merge"
(
    cd "$repo_root/luci-app-ssclash/profile-merge"
    go build -mod=vendor -o "$merger" .
)

fake_bin="$temporary_root/fake-bin"
mkdir -p "$fake_bin"
for name in curl uci jsonfilter clash clash-init clash-rules logger nslookup; do
    ln -s "$repo_root/tests/profile-sync/fake-command" "$fake_bin/$name"
done

create_case() {
    local name="$1"
    local mode="$2"
    local rules_mode="$3"
    local case_root="$temporary_root/$name"
    mkdir -p \
        "$case_root/clash" \
        "$case_root/config" \
        "$case_root/links" \
        "$case_root/state"
    cp "$fixture_dir/current.yaml" "$case_root/clash/config.yaml"
    cp "$fixture_dir/links.txt" "$case_root/links/links.txt"
    printf '%s\n' \
        "ssclash_profile.main.source_mode=$mode" \
        "ssclash_profile.main.rules_mode=$rules_mode" \
        'ssclash_profile.main.template_id=russia' \
        'ssclash_profile.main.enabled=0' \
        'ssclash_profile.main.url=https://subscription.example.invalid/profile' \
        'ssclash_profile.main.interval=3600' \
        'ssclash_profile.main.user_agent=auto' \
        'ssclash_profile.main.hwid=' \
        'ssclash_profile.main.device_os=OpenWrt' \
        'ssclash_profile.main.device_model=Test Router' \
        'ssclash_profile.main.controller=192.168.10.1:9090' \
        'ssclash_profile.main.dns_listen=127.0.0.1:7874' \
        'ssclash_profile.main.dns_mode=preserve' \
        > "$case_root/config/ssclash_profile"
    printf 'running=0\nenabled=0\n' > "$case_root/service.state"
    chmod 600 "$case_root/config/ssclash_profile" "$case_root/links/links.txt"
    printf '%s\n' "$case_root"
}

run_sync() {
    local case_root="$1"
    local scenario="$2"
    PATH="$fake_bin:$PATH" \
    FAKE_UCI_STATE="$case_root/config/ssclash_profile" \
    FAKE_CURL_COUNT="$case_root/curl.count" \
    FAKE_CURL_SCENARIO="$scenario" \
    FAKE_FIXTURE_DIR="$fixture_dir" \
    FAKE_SERVICE_STATE="$case_root/service.state" \
    SSCLASH_SELF="$helper" \
    SSCLASH_MERGER="$merger" \
    SSCLASH_CLASH="$fake_bin/clash" \
    SSCLASH_CLASH_RULES="$fake_bin/clash-rules" \
    SSCLASH_CLASH_INIT="$fake_bin/clash-init" \
    SSCLASH_CLASH_HOME="$case_root/clash" \
    SSCLASH_PROFILE_CONFIG="$case_root/config/ssclash_profile" \
    SSCLASH_BACKUP_DIR="$case_root/clash/profile-backups" \
    SSCLASH_MANAGED_SOURCE_DIR="$case_root/clash/managed-sources" \
    SSCLASH_LINKS_DIR="$case_root/links" \
    SSCLASH_TEMPLATE_DIR="$template_dir" \
    SSCLASH_VERSION_FILE="$version_file" \
    SSCLASH_STATE_DIR="$case_root/state" \
    SSCLASH_LOCK_DIR="$case_root/sync.lock" \
    SSCLASH_SOURCE_HASH_FILE="$case_root/clash/source.sha256" \
        "$helper" sync > "$case_root/result.json"
}

assert_json() {
    local file="$1"
    local expression="$2"
    jq -e "$expression" "$file" >/dev/null
}

adaptive_case="$(create_case adaptive subscription auto)"
run_sync "$adaptive_case" adaptive-links
[[ "$(<"$adaptive_case/curl.count")" == 2 ]]
[[ -z "$(awk -F= '$1 == "ssclash_profile.main.hwid" { print $2 }' "$adaptive_case/config/ssclash_profile")" ]]
assert_json "$adaptive_case/state/status.json" '.state == "success"'
assert_json "$adaptive_case/state/status.json" '.hwid_used == false'
assert_json "$adaptive_case/state/status.json" '.summary.source_format == "links"'
assert_json "$adaptive_case/state/status.json" '.summary.rules_source == "template"'
assert_json "$adaptive_case/state/status.json" '.summary.template_id == "russia"'
assert_json "$adaptive_case/state/status.json" '.summary.input_links == 2'
assert_json "$adaptive_case/state/status.json" '.summary.skipped_lines == 1'
grep -q 'type: file' "$adaptive_case/clash/config.yaml"
grep -Eq 'path: \./managed-sources/[a-f0-9]{64}\.txt' "$adaptive_case/clash/config.yaml"
[[ "$(find "$adaptive_case/clash/managed-sources" -type f -name '*.txt' | wc -l)" == 1 ]]

hwid_case="$(create_case hwid subscription auto)"
run_sync "$hwid_case" hwid-full
[[ "$(<"$hwid_case/curl.count")" == 3 ]]
generated_hwid="$(awk -F= '$1 == "ssclash_profile.main.hwid" { print $2 }' "$hwid_case/config/ssclash_profile")"
[[ "$generated_hwid" =~ ^[A-Za-z0-9=-]{10,64}$ ]]
assert_json "$hwid_case/state/status.json" '.state == "success"'
assert_json "$hwid_case/state/status.json" '.hwid_used == true'
assert_json "$hwid_case/state/status.json" '.summary.source_format == "full"'
assert_json "$hwid_case/state/status.json" '.summary.rules_source == "remote"'
grep -q 'name: REMOTE' "$hwid_case/clash/config.yaml"

limit_case="$(create_case hwid-limit subscription auto)"
if run_sync "$limit_case" hwid-limit; then
    printf 'An exhausted HWID limit unexpectedly succeeded.\n' >&2
    exit 1
fi
[[ "$(<"$limit_case/curl.count")" == 1 ]]
[[ -z "$(awk -F= '$1 == "ssclash_profile.main.hwid" { print $2 }' "$limit_case/config/ssclash_profile")" ]]
assert_json "$limit_case/state/status.json" '.state == "error"'
assert_json "$limit_case/state/status.json" '.code == "hwid_limit_reached"'

changed_case="$(create_case source-changed subscription auto)"
changed_before_hash="$(sha256sum "$changed_case/clash/config.yaml" | awk '{print $1}')"
if run_sync "$changed_case" source-changed; then
    printf 'A stale candidate unexpectedly replaced the active profile.\n' >&2
    exit 1
fi
changed_after_hash="$(sha256sum "$changed_case/clash/config.yaml" | awk '{print $1}')"
[[ "$changed_before_hash" == "$changed_after_hash" ]]
assert_json "$changed_case/state/status.json" '.state == "error"'
assert_json "$changed_case/state/status.json" '.code == "source_changed"'

links_case="$(create_case links links auto)"
run_sync "$links_case" invalid
[[ ! -e "$links_case/curl.count" ]]
assert_json "$links_case/state/status.json" '.state == "success"'
assert_json "$links_case/state/status.json" '.summary.source_format == "links"'
assert_json "$links_case/state/status.json" '.summary.rules_source == "template"'
assert_json "$links_case/state/status.json" '.summary.skipped_lines == 1'

invalid_case="$(create_case invalid subscription auto)"
before_hash="$(sha256sum "$invalid_case/clash/config.yaml" | awk '{print $1}')"
if run_sync "$invalid_case" invalid; then
    printf 'Invalid subscription unexpectedly succeeded.\n' >&2
    exit 1
fi
after_hash="$(sha256sum "$invalid_case/clash/config.yaml" | awk '{print $1}')"
[[ "$before_hash" == "$after_hash" ]]
[[ "$(<"$invalid_case/curl.count")" == 2 ]]
[[ -z "$(awk -F= '$1 == "ssclash_profile.main.hwid" { print $2 }' "$invalid_case/config/ssclash_profile")" ]]
assert_json "$invalid_case/state/status.json" '.state == "error"'
assert_json "$invalid_case/state/status.json" '.code == "no_usable_proxies"'

printf 'profile-sync integration tests passed\n'
