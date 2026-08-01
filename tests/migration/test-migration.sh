#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
migration="$repo_root/luci-app-ssclash/rootfs/usr/libexec/ssclash-party-migrate"
shared_fake="$repo_root/tests/profile-sync/fake-command"
router_fake="$repo_root/tests/router-integration/fake-command"
temporary_root="$(mktemp -d)"
cleanup() {
    local saved_status
    saved_status=$?
    rm -rf "$temporary_root"
    exit "$saved_status"
}
trap cleanup EXIT

fake_bin="$temporary_root/fake-bin"
mkdir -p "$fake_bin"
ln -s "$shared_fake" "$fake_bin/uci"
ln -s "$router_fake" "$fake_bin/ubus"
ln -s "$router_fake" "$fake_bin/jsonfilter"

state="$temporary_root/ssclash_profile"
active_config="$temporary_root/config.yaml"
settings="$temporary_root/settings"

printf '%s\n' \
    'ssclash_profile.main=profile' \
    'ssclash_profile.main.source_mode=subscription' \
    'ssclash_profile.main.rules_mode=auto' \
    'ssclash_profile.main.template_id=russia' \
    'ssclash_profile.main.enabled=1' \
    'ssclash_profile.main.url=https://subscription.example.invalid/profile?client=legacy&format=yaml' \
    'ssclash_profile.main.interval=3600' \
    'ssclash_profile.main.user_agent=mihomo/1.19.29' \
    'ssclash_profile.main.hwid=legacy-router-id' \
    'ssclash_profile.main.device_os=OpenWrt' \
    'ssclash_profile.main.device_model=Migration Fixture' \
    'ssclash_profile.main.lan_interface=lan' \
    'ssclash_profile.main.controller=192.168.10.1:9191' \
    'ssclash_profile.main.dns_listen=127.0.0.1:7874' \
    'ssclash_profile.main.dns_mode=preserve' \
    > "$state"

printf '%s\n' \
    'mode: rule' \
    'tproxy-port: 8894' \
    'routing-mark: 12' \
    'ipv6: false' \
    'external-controller: 192.168.10.1:9191' \
    'dns:' \
    '  enable: true' \
    '  enhanced-mode: fake-ip' \
    '  fake-ip-range: 198.19.0.1/16' \
    '  fake-ip-filter-mode: blacklist' \
    '  fake-ip-filter:' \
    '    - printer.home' \
    'profile:' \
    '  store-fake-ip: true' \
    > "$active_config"
printf '%s\n' 'PROXY_MODE=mixed' 'TUN_STACK=gvisor' > "$settings"
chmod 600 "$state" "$active_config" "$settings"

PATH="$fake_bin:$PATH" \
FAKE_UCI_STATE="$state" \
SSCLASH_PROFILE_CONFIG="$state" \
SSCLASH_ACTIVE_CONFIG="$active_config" \
SSCLASH_SETTINGS_FILE="$settings" \
    "$migration" > "$temporary_root/output"

[[ ! -s "$temporary_root/output" ]]
grep -Fqx 'ssclash_profile.main=globals' "$state"
grep -Fqx 'ssclash_profile.main.active_profile=default' "$state"
grep -Fqx 'ssclash_profile.default=subscription' "$state"
grep -Fqx 'ssclash_profile.default.url=https://subscription.example.invalid/profile?client=legacy&format=yaml' "$state"
grep -Fqx 'ssclash_profile.default.user_agent=auto' "$state"
grep -Fqx 'ssclash_profile.default.hwid=legacy-router-id' "$state"
grep -Fqx 'ssclash_profile.router.dns_mode=fake-ip' "$state"
grep -Fqx 'ssclash_profile.router.fake_ip_range=198.19.0.1/16' "$state"
grep -Fqx 'ssclash_profile.router.store_fake_ip=1' "$state"
grep -Fqx 'ssclash_profile.router.fake_ip_filter=printer.home *.lan *.local panel.router' "$state"
grep -Fqx 'ssclash_profile.router.proxy_mode=mixed' "$state"
grep -Fqx 'ssclash_profile.router.tproxy_port=8894' "$state"
grep -Fqx 'ssclash_profile.router.routing_mark=12' "$state"
grep -Fqx 'ssclash_profile.router.tun_stack=gvisor' "$state"
grep -Fqx 'ssclash_profile.router.controller_mode=auto' "$state"
grep -Fqx 'ssclash_profile.router.controller_port=9191' "$state"
if grep -Eq '^ssclash_profile\.main\.(enabled|url|interval|user_agent|hwid|device_os|device_model|controller|controller_port|dns_listen|dns_mode)=' "$state"; then
    printf 'Migrated legacy options remain duplicated in the globals section.\n' >&2
    exit 1
fi
[[ "$(stat -c '%a' "$state")" == 600 ]]

sed -i 's/ssclash_profile.router.dns_mode=fake-ip/ssclash_profile.router.dns_mode=redir-host/' "$state"
sed -i 's/ssclash_profile.router.tproxy_port=8894/ssclash_profile.router.tproxy_port=9994/' "$state"
before_default_count="$(grep -c '^ssclash_profile\.default=subscription$' "$state")"
PATH="$fake_bin:$PATH" \
FAKE_UCI_STATE="$state" \
SSCLASH_PROFILE_CONFIG="$state" \
SSCLASH_ACTIVE_CONFIG="$active_config" \
SSCLASH_SETTINGS_FILE="$settings" \
    "$migration"
[[ "$(grep -c '^ssclash_profile\.default=subscription$' "$state")" == "$before_default_count" ]]
grep -Fqx 'ssclash_profile.router.dns_mode=redir-host' "$state"
grep -Fqx 'ssclash_profile.router.tproxy_port=9994' "$state"

printf 'legacy migration tests passed\n'
