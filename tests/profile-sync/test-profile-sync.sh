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
for name in curl uci jsonfilter ubus clash clash-init clash-rules logger nslookup; do
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
        "$case_root/custom-templates" \
        "$case_root/links" \
        "$case_root/state"
    cp "$fixture_dir/current.yaml" "$case_root/clash/config.yaml"
    cp "$fixture_dir/links.txt" "$case_root/links/links.txt"
    printf '%s\n' \
        "ssclash_profile.main.source_mode=$mode" \
        'ssclash_profile.main.active_profile=default' \
        'ssclash_profile.main.rules_mode=template' \
        'ssclash_profile.main.template_id=russia' \
        'ssclash_profile.default=subscription' \
        'ssclash_profile.default.name=Default' \
        'ssclash_profile.default.enabled=0' \
        'ssclash_profile.default.url=https://subscription.example.invalid/profile' \
        "ssclash_profile.default.rules_mode=$rules_mode" \
        'ssclash_profile.default.template_id=russia' \
        'ssclash_profile.default.interval=3600' \
        'ssclash_profile.default.user_agent=auto' \
        'ssclash_profile.default.hwid=' \
        'ssclash_profile.default.device_os=OpenWrt' \
        'ssclash_profile.default.device_model=Test Router' \
        'ssclash_profile.router=router' \
        'ssclash_profile.router.controller_mode=custom' \
        'ssclash_profile.router.controller_host=192.168.10.1' \
        'ssclash_profile.router.controller_port=9090' \
        'ssclash_profile.router.dns_listen=127.0.0.1:7874' \
        'ssclash_profile.router.dns_mode=redir-host' \
        'ssclash_profile.router.proxy_mode=tproxy' \
        'ssclash_profile.router.tproxy_port=7894' \
        'ssclash_profile.router.routing_mark=2' \
        'ssclash_profile.router.tun_stack=system' \
        'ssclash_profile.router.ipv6_enabled=0' \
        'ssclash_profile.router.panel_enabled=1' \
        'ssclash_profile.router.panel_hostname=panel.router' \
        > "$case_root/config/ssclash_profile"
    printf 'running=0\nenabled=0\n' > "$case_root/service.state"
    chmod 600 "$case_root/config/ssclash_profile" "$case_root/links/links.txt"
    printf '%s\n' "$case_root"
}

run_action() {
    local case_root="$1"
    local scenario="$2"
    shift 2
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
    SSCLASH_PROFILE_CACHE_DIR="$case_root/clash/profile-cache" \
    SSCLASH_LINKS_DIR="$case_root/links" \
    SSCLASH_TEMPLATE_DIR="$template_dir" \
    SSCLASH_CUSTOM_TEMPLATE_DIR="$case_root/custom-templates" \
    SSCLASH_VERSION_FILE="$version_file" \
    SSCLASH_STATE_DIR="$case_root/state" \
    SSCLASH_LOCK_DIR="$case_root/sync.lock" \
    SSCLASH_SOURCE_HASH_FILE="$case_root/clash/source.sha256" \
        "$helper" "$@" > "$case_root/result.json"
}

run_sync() {
    run_action "$1" "$2" sync
}

assert_json() {
    local file="$1"
    local expression="$2"
    jq -e "$expression" "$file" >/dev/null
}

append_backup_profile() {
    local case_root="$1"
    local rules_mode="${2:-auto}"
    cat >> "$case_root/config/ssclash_profile" <<EOF
ssclash_profile.backup=subscription
ssclash_profile.backup.name=Backup
ssclash_profile.backup.enabled=0
ssclash_profile.backup.url=https://subscription.example.invalid/backup
ssclash_profile.backup.rules_mode=$rules_mode
ssclash_profile.backup.template_id=russia
ssclash_profile.backup.interval=7200
ssclash_profile.backup.user_agent=auto
ssclash_profile.backup.hwid=
ssclash_profile.backup.device_os=OpenWrt
ssclash_profile.backup.device_model=Test Router
EOF
}

adaptive_case="$(create_case adaptive subscription auto)"
run_sync "$adaptive_case" adaptive-links
[[ "$(<"$adaptive_case/curl.count")" == 2 ]]
[[ -z "$(awk -F= '$1 == "ssclash_profile.default.hwid" { print $2 }' "$adaptive_case/config/ssclash_profile")" ]]
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
generated_hwid="$(awk -F= '$1 == "ssclash_profile.default.hwid" { print $2 }' "$hwid_case/config/ssclash_profile")"
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
[[ -z "$(awk -F= '$1 == "ssclash_profile.default.hwid" { print $2 }' "$limit_case/config/ssclash_profile")" ]]
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

custom_template_case="$(create_case custom-template subscription template)"
mkdir -p "$custom_template_case/custom-templates/custom"
cat > "$custom_template_case/custom-templates/custom/template.yaml" <<'EOF'
proxy-groups:
  - name: CUSTOM-POLICY
    type: select
    include-all: true
rules:
  - MATCH,CUSTOM-POLICY
EOF
printf '%s\n' '{"id":"custom","name":"Custom","description":"Test","revision":1}' > \
    "$custom_template_case/custom-templates/custom/metadata.json"
sed -i \
    -e 's/^ssclash_profile\.main\.template_id=.*/ssclash_profile.main.template_id=custom/' \
    -e 's/^ssclash_profile\.default\.template_id=.*/ssclash_profile.default.template_id=custom/' \
    "$custom_template_case/config/ssclash_profile"
run_sync "$custom_template_case" full
assert_json "$custom_template_case/state/status.json" '.state == "success" and .summary.template_id == "custom"'
grep -q 'name: CUSTOM-POLICY' "$custom_template_case/clash/config.yaml"

invalid_case="$(create_case invalid subscription auto)"
before_hash="$(sha256sum "$invalid_case/clash/config.yaml" | awk '{print $1}')"
if run_sync "$invalid_case" invalid; then
    printf 'Invalid subscription unexpectedly succeeded.\n' >&2
    exit 1
fi
after_hash="$(sha256sum "$invalid_case/clash/config.yaml" | awk '{print $1}')"
[[ "$before_hash" == "$after_hash" ]]
[[ "$(<"$invalid_case/curl.count")" == 2 ]]
[[ -z "$(awk -F= '$1 == "ssclash_profile.default.hwid" { print $2 }' "$invalid_case/config/ssclash_profile")" ]]
assert_json "$invalid_case/state/status.json" '.state == "error"'
assert_json "$invalid_case/state/status.json" '.code == "no_usable_proxies"'

auto_controller_case="$(create_case auto-controller subscription auto)"
sed -i \
    -e 's/^ssclash_profile\.router\.controller_mode=.*/ssclash_profile.router.controller_mode=auto/' \
    -e '/^ssclash_profile\.router\.controller_host=/d' \
    "$auto_controller_case/config/ssclash_profile"
FAKE_LAN_ADDRESS=192.168.20.1 run_sync "$auto_controller_case" full
grep -q '^external-controller: 192\.168\.20\.1:9090$' "$auto_controller_case/clash/config.yaml"
assert_json "$auto_controller_case/state/status.json" '.state == "success"'

panel_disabled_case="$(create_case panel-disabled subscription auto)"
sed -i \
    's/^ssclash_profile\.router\.panel_enabled=.*/ssclash_profile.router.panel_enabled=0/' \
    "$panel_disabled_case/config/ssclash_profile"
run_sync "$panel_disabled_case" full
if grep -q 'panel\.router' "$panel_disabled_case/clash/config.yaml"; then
    printf 'A disabled friendly hostname remains in controller CORS.\n' >&2
    exit 1
fi
grep -q 'http://192\.168\.10\.1' "$panel_disabled_case/clash/config.yaml"
assert_json "$panel_disabled_case/state/status.json" '.state == "success"'

profiles_case="$(create_case profiles subscription auto)"
append_backup_profile "$profiles_case"
profiles_before_hash="$(sha256sum "$profiles_case/clash/config.yaml" | awk '{print $1}')"
run_action "$profiles_case" full validate backup
profiles_after_validate_hash="$(sha256sum "$profiles_case/clash/config.yaml" | awk '{print $1}')"
[[ "$profiles_before_hash" == "$profiles_after_validate_hash" ]]
[[ -s "$profiles_case/clash/profile-cache/backup.yaml" ]]
[[ "$(awk -F= '$1 == "ssclash_profile.main.active_profile" { print $2 }' "$profiles_case/config/ssclash_profile")" == default ]]
assert_json "$profiles_case/state/status.json" '.state == "success" and .code == "validated" and .profile_id == "backup"'

rm -f "$profiles_case/curl.count"
run_action "$profiles_case" full activate backup
[[ "$(awk -F= '$1 == "ssclash_profile.main.active_profile" { print $2 }' "$profiles_case/config/ssclash_profile")" == backup ]]
assert_json "$profiles_case/state/status.json" '.state == "success" and .profile_id == "backup"'
grep -q 'name: REMOTE' "$profiles_case/clash/config.yaml"

printf 'cached\n' > "$profiles_case/clash/profile-cache/default.yaml"
printf 'revision\n' > "$profiles_case/clash/profile-cache/default.revision"
run_action "$profiles_case" full delete default
if grep -q '^ssclash_profile\.default=' "$profiles_case/config/ssclash_profile"; then
    printf 'The deleted subscription profile remains in UCI.\n' >&2
    exit 1
fi
[[ ! -e "$profiles_case/clash/profile-cache/default.yaml" ]]
[[ ! -e "$profiles_case/clash/profile-cache/default.revision" ]]
assert_json "$profiles_case/state/status.json" '.state == "success" and .code == "deleted" and .profile_id == "default"'

if run_action "$profiles_case" full delete backup; then
    printf 'The active subscription profile was unexpectedly deleted.\n' >&2
    exit 1
fi
grep -q '^ssclash_profile\.backup=subscription$' "$profiles_case/config/ssclash_profile"
assert_json "$profiles_case/state/status.json" '.state == "error" and .code == "active_profile"'

running_switch_case="$(create_case running-switch subscription auto)"
append_backup_profile "$running_switch_case" template
run_sync "$running_switch_case" full
running_before_hash="$(sha256sum "$running_switch_case/clash/config.yaml" | awk '{print $1}')"
printf 'running=1\nenabled=1\n' > "$running_switch_case/service.state"
rm -f "$running_switch_case/curl.count"
run_action "$running_switch_case" full activate backup
running_after_hash="$(sha256sum "$running_switch_case/clash/config.yaml" | awk '{print $1}')"
[[ "$running_before_hash" != "$running_after_hash" ]]
[[ "$(awk -F= '$1 == "ssclash_profile.main.active_profile" { print $2 }' "$running_switch_case/config/ssclash_profile")" == backup ]]
grep -qx 'running=1' "$running_switch_case/service.state"
assert_json "$running_switch_case/state/status.json" '.state == "success" and .profile_id == "backup"'

running_rollback_case="$(create_case running-rollback subscription auto)"
append_backup_profile "$running_rollback_case" template
run_sync "$running_rollback_case" full
rollback_before_hash="$(sha256sum "$running_rollback_case/clash/config.yaml" | awk '{print $1}')"
printf 'running=1\nenabled=1\n' > "$running_rollback_case/service.state"
rm -f "$running_rollback_case/curl.count"
export FAKE_CONTROLLER_FAIL_ONCE_FILE="$running_rollback_case/controller.fail-once"
if run_action "$running_rollback_case" full activate backup; then
    printf 'A failed running-profile reload unexpectedly activated the profile.\n' >&2
    exit 1
fi
unset FAKE_CONTROLLER_FAIL_ONCE_FILE
rollback_after_hash="$(sha256sum "$running_rollback_case/clash/config.yaml" | awk '{print $1}')"
[[ "$rollback_before_hash" == "$rollback_after_hash" ]]
[[ "$(awk -F= '$1 == "ssclash_profile.main.active_profile" { print $2 }' "$running_rollback_case/config/ssclash_profile")" == default ]]
grep -qx 'running=1' "$running_rollback_case/service.state"
assert_json "$running_rollback_case/state/status.json" '.state == "error" and .code == "reload_failed" and .profile_id == "backup"'

printf 'profile-sync integration tests passed\n'
