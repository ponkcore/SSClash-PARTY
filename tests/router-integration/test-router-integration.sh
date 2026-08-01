#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
router_helper="$repo_root/luci-app-ssclash/rootfs/usr/libexec/ssclash-router-integration"
panel_helper="$repo_root/luci-app-ssclash/rootfs/usr/libexec/ssclash-party-panel"
shared_fake="$repo_root/tests/profile-sync/fake-command"
local_fake="$repo_root/tests/router-integration/fake-command"
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
for name in ip profile-sync panel-helper ubus jsonfilter; do
    ln -s "$local_fake" "$fake_bin/$name"
done
for name in dnsmasq-init uhttpd-init; do
    ln -s "$local_fake" "$fake_bin/$name"
done

state="$temporary_root/ssclash_profile"
sync_calls="$temporary_root/sync.calls"
panel_calls="$temporary_root/panel.calls"
service_calls="$temporary_root/service.calls"

write_base_state() {
    : > "$sync_calls"
    : > "$panel_calls"
    printf '%s\n' \
        'ssclash_profile.main=globals' \
        'ssclash_profile.main.source_mode=subscription' \
        'ssclash_profile.main.active_profile=default' \
        'ssclash_profile.default=subscription' \
        'ssclash_profile.default.url=https://subscription.example.invalid/profile' \
        'ssclash_profile.router=router' \
        'ssclash_profile.router.dns_mode=redir-host' \
        'ssclash_profile.router.dns_listen=127.0.0.1:7874' \
        'ssclash_profile.router.fake_ip_range=198.18.0.1/16' \
        'ssclash_profile.router.fake_ip_filter_mode=blacklist' \
        'ssclash_profile.router.store_fake_ip=1' \
        'ssclash_profile.router.fake_ip_filter=*.lan *.local panel.router' \
        'ssclash_profile.router.proxy_mode=tproxy' \
        'ssclash_profile.router.tproxy_port=7894' \
        'ssclash_profile.router.routing_mark=2' \
        'ssclash_profile.router.tun_stack=system' \
        'ssclash_profile.router.ipv6_enabled=0' \
        'ssclash_profile.router.controller_mode=auto' \
        'ssclash_profile.router.controller_port=9090' \
        'ssclash_profile.router.panel_enabled=1' \
        'ssclash_profile.router.panel_hostname=panel.router' \
        > "$state"
    chmod 600 "$state"
}

stage_pending() {
    local dns_mode="$1"
    local filters="$2"
    {
        printf '%s\n' \
            'ssclash_profile.pending=router' \
            "ssclash_profile.pending.dns_mode=$dns_mode" \
            'ssclash_profile.pending.dns_listen=127.0.0.1:7874' \
            'ssclash_profile.pending.fake_ip_range=198.18.0.1/16' \
            'ssclash_profile.pending.fake_ip_filter_mode=blacklist' \
            'ssclash_profile.pending.store_fake_ip=1' \
            "ssclash_profile.pending.fake_ip_filter=$filters" \
            'ssclash_profile.pending.proxy_mode=tproxy' \
            'ssclash_profile.pending.tproxy_port=7894' \
            'ssclash_profile.pending.routing_mark=2' \
            'ssclash_profile.pending.tun_stack=system' \
            'ssclash_profile.pending.ipv6_enabled=0' \
            'ssclash_profile.pending.controller_mode=auto' \
            'ssclash_profile.pending.controller_port=9090' \
            'ssclash_profile.pending.panel_enabled=1' \
            'ssclash_profile.pending.panel_hostname=panel.router'
    } >> "$state"
}

run_router() {
    PATH="$fake_bin:$PATH" \
    FAKE_UCI_STATE="$state" \
    FAKE_IP_ROUTES="${FAKE_IP_ROUTES:-}" \
    FAKE_SYNC_CALLS="$sync_calls" \
    FAKE_PANEL_CALLS="$panel_calls" \
    FAKE_PANEL_EXIT="${FAKE_PANEL_EXIT:-0}" \
    FAKE_SYNC_EXIT="${FAKE_SYNC_EXIT:-0}" \
    SSCLASH_PROFILE_CONFIG="$state" \
    SSCLASH_PROFILE_SYNC="$fake_bin/profile-sync" \
    SSCLASH_PANEL_HELPER="$fake_bin/panel-helper" \
        "$router_helper" "$1"
}

write_base_state
stage_pending redir-host '*.lan *.local panel.router'
run_router preflight | jq -e '.ok == true and .blockers == 0' >/dev/null

write_base_state
stage_pending redir-host '*.lan *.local panel.router'
sed -i \
    -e 's/^ssclash_profile\.pending\.controller_mode=.*/ssclash_profile.pending.controller_mode=custom/' \
    "$state"
printf '%s\n' 'ssclash_profile.pending.controller_host=127.0.0.1' >> "$state"
if run_router preflight > "$temporary_root/loopback-controller.json"; then
    printf 'A browser-inaccessible loopback controller unexpectedly passed preflight.\n' >&2
    exit 1
fi
jq -e '.ok == false and .blockers >= 1' "$temporary_root/loopback-controller.json" >/dev/null

write_base_state
stage_pending fake-ip 'example.invalid'
if run_router preflight > "$temporary_root/preflight.json"; then
    printf 'Unsafe Fake-IP settings unexpectedly passed preflight.\n' >&2
    exit 1
fi
jq -e '.ok == false and .corrections == 3' "$temporary_root/preflight.json" >/dev/null
run_router correct | jq -e '.ok == true' >/dev/null
grep -Fq 'ssclash_profile.pending.fake_ip_filter=example.invalid *.lan *.local panel.router' "$state"

write_base_state
stage_pending fake-ip '*.lan *.local'
sed -i 's/^ssclash_profile\.pending\.panel_enabled=.*/ssclash_profile.pending.panel_enabled=0/' "$state"
run_router preflight | jq -e '.ok == true and .corrections == 0' >/dev/null

FAKE_IP_ROUTES='198.18.0.0/16 dev clash-test proto kernel scope link'
if run_router preflight > "$temporary_root/overlap.json"; then
    printf 'An overlapping Fake-IP range unexpectedly passed preflight.\n' >&2
    exit 1
fi
jq -e '.ok == false and .blockers >= 1' "$temporary_root/overlap.json" >/dev/null
unset FAKE_IP_ROUTES

write_base_state
stage_pending redir-host '*.lan *.local panel.router'
run_router apply | jq -e '.state == "success"' >/dev/null
grep -qx 'sync' "$sync_calls"
grep -qx 'apply' "$panel_calls"
if grep -q '^ssclash_profile\.pending' "$state"; then
    printf 'The staged Router Integration section was not removed.\n' >&2
    exit 1
fi

write_base_state
stage_pending fake-ip '*.lan *.local panel.router'
before_hash="$(sha256sum "$state" | awk '{print $1}')"
export FAKE_PANEL_EXIT=8
if run_router apply > "$temporary_root/panel-apply-failed.json"; then
    printf 'A synthetic panel failure unexpectedly activated Router Integration.\n' >&2
    exit 1
fi
unset FAKE_PANEL_EXIT
jq -e '.code == "panel_apply_failed"' "$temporary_root/panel-apply-failed.json" >/dev/null
after_hash="$(sha256sum "$state" | awk '{print $1}')"
[[ "$before_hash" == "$after_hash" ]]
[[ ! -s "$sync_calls" ]]

write_base_state
stage_pending fake-ip '*.lan *.local panel.router'
before_hash="$(sha256sum "$state" | awk '{print $1}')"
export FAKE_SYNC_EXIT=7
if run_router apply > "$temporary_root/apply-failed.json"; then
    printf 'A synthetic profile failure unexpectedly activated Router Integration.\n' >&2
    exit 1
fi
unset FAKE_SYNC_EXIT
jq -e '.code == "sync_failed"' "$temporary_root/apply-failed.json" >/dev/null
after_hash="$(sha256sum "$state" | awk '{print $1}')"
[[ "$before_hash" == "$after_hash" ]]

panel_state="$temporary_root/panel-state"
panel_host_config="$temporary_root/www/ssclash-party-host.js"
mkdir -p "$(dirname "$panel_host_config")"
printf '%s\n' \
    'ssclash_profile.main=globals' \
    'ssclash_profile.main.lan_interface=lan' \
    'ssclash_profile.router=router' \
    'ssclash_profile.router.panel_enabled=1' \
    'ssclash_profile.router.panel_hostname=panel.router' \
    'network.lan.device=br-lan' \
    'dhcp.@dnsmasq[0]=dnsmasq' \
    'dhcp.@dnsmasq[0].interface_name=legacy.router,br-lan' \
    'dhcp.lan=dhcp' \
    'dhcp.lan.interface=lan' \
    'uhttpd.main=uhttpd' \
    'uhttpd.main.index_page=cgi-bin/luci index.html' \
    'uhttpd.main.alias=/party-dashboard=/opt/clash/ui' \
    > "$state"
: > "$service_calls"
mkdir -p "$panel_state"
printf '%s\n' \
    'enabled=1' \
    'hostname=legacy.router' \
    'device=br-lan' \
    > "$panel_state/panel.state"
run_panel() {
    PATH="$fake_bin:$PATH" \
    FAKE_UCI_STATE="$state" \
    FAKE_SERVICE_CALLS="$service_calls" \
    SSCLASH_PANEL_STATE_DIR="$panel_state" \
    SSCLASH_PANEL_HOST_CONFIG="$panel_host_config" \
    SSCLASH_DNSMASQ_INIT="$fake_bin/dnsmasq-init" \
    SSCLASH_UHTTPD_INIT="$fake_bin/uhttpd-init" \
    SSCLASH_PANEL_RESTART_DELAY=0 \
        "$panel_helper" "$1"
}
run_panel apply | jq -e '.ok == true and .enabled == 1 and .hostname == "panel.router"' >/dev/null
grep -Fqx 'dhcp.lan.interface_name=panel.router' "$state"
if grep -Fq 'dhcp.@dnsmasq[0].interface_name=legacy.router,br-lan' "$state"; then
    printf 'The inert PARTY.4 global interface_name value was not removed.\n' >&2
    exit 1
fi
grep -Fqx 'uhttpd.main.index_page=ssclash-party-index.html cgi-bin/luci index.html' "$state"
if grep -Fq 'uhttpd.main.alias=/party-dashboard=/opt/clash/ui' "$state"; then
    printf 'The broken PARTY.4 uHTTPd rewrite remains after migration.\n' >&2
    exit 1
fi
grep -Fq "ln -s /opt/clash/ui \$(1)/www/party-dashboard" \
    "$repo_root/luci-app-ssclash/Makefile"
grep -Fq 'panel.router' "$panel_host_config"

sed -i 's/ssclash_profile.router.panel_hostname=panel.router/ssclash_profile.router.panel_hostname=party.router/' "$state"
run_panel apply >/dev/null
if grep -Fq 'dhcp.lan.interface_name=panel.router' "$state"; then
    printf 'The previous friendly panel DNS record was not removed.\n' >&2
    exit 1
fi
grep -Fqx 'dhcp.lan.interface_name=party.router' "$state"
[[ "$(awk -F= '$1 == "uhttpd.main.index_page" { print $2 }' "$state")" == 'ssclash-party-index.html cgi-bin/luci index.html' ]]

sed -i 's/ssclash_profile.router.panel_enabled=1/ssclash_profile.router.panel_enabled=0/' "$state"
if ! run_panel apply > "$temporary_root/panel-disable.json"; then
    printf 'Disabling the friendly panel integration failed.\n' >&2
    exit 1
fi
if grep -q '^dhcp\.lan\.interface_name=' "$state"; then
    printf 'A friendly panel DNS record remains after disabling the feature.\n' >&2
    exit 1
fi
[[ "$(awk -F= '$1 == "uhttpd.main.index_page" { print $2 }' "$state")" == 'cgi-bin/luci index.html' ]]
if grep -q '^uhttpd\.main\.alias=' "$state"; then
    printf 'The dashboard uHTTPd alias remains after disabling the feature.\n' >&2
    exit 1
fi

printf 'router integration and panel tests passed\n'
