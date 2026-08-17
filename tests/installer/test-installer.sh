#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "$0")/../.." && pwd)
installer="$repository_root/install-ssclash.sh"
manifest="$repository_root/installer/channels/preview.manifest"
generator="$repository_root/scripts/build-installer-manifest.sh"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

fail() {
    echo "installer test failed: $*" >&2
    exit 1
}

assert_contains() {
    local output=$1
    local expected=$2
    grep -Fq "$expected" <<<"$output" || fail "missing output: $expected"
}

base_environment=(
    env
    SSCLASH_PARTY_TESTING=1
    SSCLASH_PARTY_TEST_RELEASE=25.12.5
    SSCLASH_PARTY_TEST_TARGET=mediatek/filogic
    SSCLASH_PARTY_TEST_ARCH=aarch64_cortex-a53
    "SSCLASH_PARTY_TEST_BOARD=cudy,wbr3000uax-v1-ubootmod"
    "SSCLASH_PARTY_TEST_MODEL=Cudy WBR3000UAX"
    SSCLASH_PARTY_TEST_PACKAGE_MANAGER=apk
    SSCLASH_PARTY_TEST_MANAGER_ARCH=aarch64
    SSCLASH_PARTY_TEST_FIREWALL=fw4
    SSCLASH_PARTY_TEST_MEMORY_KIB=524288
    SSCLASH_PARTY_TEST_OVERLAY_FREE_KIB=131072
    SSCLASH_PARTY_TEST_TMP_FREE_KIB=262144
    SSCLASH_PARTY_CHANNEL=preview
    "SSCLASH_PARTY_TEST_MANIFEST=file://$manifest"
)

output=$("${base_environment[@]}" sh "$installer" doctor 2>&1)
assert_contains "$output" 'Doctor result: supported and safe to continue.'
assert_contains "$output" 'Device support: live-tested board'
assert_contains "$output" 'luci-app-ssclash-4.7.0-r7-openwrt-25.12.5-mediatek-filogic-aarch64_cortex-a53.apk'
assert_contains "$output" 'mihomo-linux-arm64-v1.19.29.gz'

output=$("${base_environment[@]}" \
    SSCLASH_PARTY_TEST_RELEASE=24.10.8 \
    SSCLASH_PARTY_TEST_TARGET=x86/64 \
    SSCLASH_PARTY_TEST_ARCH=x86_64 \
    SSCLASH_PARTY_TEST_BOARD=generic-x86-64 \
    SSCLASH_PARTY_TEST_PACKAGE_MANAGER=opkg \
    SSCLASH_PARTY_TEST_MANAGER_ARCH=x86_64 \
    sh "$installer" doctor 2>&1)
assert_contains "$output" 'luci-app-ssclash_4.7.0-r7_x86_64-openwrt-24.10.8-x86-64-x86_64.ipk'
assert_contains "$output" 'mihomo-linux-amd64-compatible-v1.19.29.gz'

if output=$("${base_environment[@]}" \
    SSCLASH_PARTY_TEST_MANAGER_ARCH=x86_64 \
    sh "$installer" doctor 2>&1); then
    fail 'inconsistent apk architecture unexpectedly passed'
fi
assert_contains "$output" 'apk reports architecture x86_64, expected aarch64'

if output=$("${base_environment[@]}" \
    SSCLASH_PARTY_TEST_TARGET=qualcommax/ipq807x \
    sh "$installer" doctor 2>&1); then
    fail 'unsupported target unexpectedly passed'
fi
assert_contains "$output" 'No verified PARTY package exactly matches this OpenWrt system'
assert_contains "$output" 'Nothing was changed.'

if output=$("${base_environment[@]}" \
    SSCLASH_PARTY_TEST_INSTALLED_PACKAGES=sing-box \
    sh "$installer" doctor 2>&1); then
    fail 'conflicting proxy package unexpectedly passed'
fi
assert_contains "$output" 'Conflicting proxy packages were detected:'
assert_contains "$output" 'sing-box'

if output=$("${base_environment[@]}" \
    SSCLASH_PARTY_TEST_PACKAGE_MANAGER=opkg \
    sh "$installer" doctor 2>&1); then
    fail 'wrong package manager unexpectedly passed'
fi
assert_contains "$output" 'cannot be installed with opkg'

output=$("${base_environment[@]}" sh "$installer" install --dry-run --yes 2>&1)
assert_contains "$output" 'Dry run complete; no changes were made.'

output=$("${base_environment[@]}" sh "$installer" check 2>&1)
assert_contains "$output" 'SSCLASH_PARTY_UPDATE|none|4.7.0-party.5|update-available'

api_payload="$temporary/api-payload"
mkdir -p "$api_payload"
cp "$manifest" "$api_payload/ssclash-party-preview-manifest"
(
    cd "$api_payload"
    sha256sum ssclash-party-preview-manifest > \
        ssclash-party-preview-manifest.sha256
)
printf '%s\n' \
    '[{"assets":[{"browser_download_url":"https://github.com/ponkcore/SSClash-PARTY/releases/download/v9.0.0-party.1/ssclash-party-stable-manifest"}]},{"assets":[{"browser_download_url":"https://github.com/ponkcore/SSClash-PARTY/releases/download/v4.7.0-party.5/ssclash-party-preview-manifest"}]}]' \
    > "$api_payload/releases?per_page=20"
output=$("${base_environment[@]}" \
    SSCLASH_PARTY_TEST_MANIFEST= \
    SSCLASH_PARTY_TEST_PAYLOAD_DIR="$api_payload" \
    sh "$installer" doctor 2>&1)
assert_contains "$output" '/v4.7.0-party.5/ssclash-party-preview-manifest'

stable_manifest="$api_payload/ssclash-party-stable-manifest"
sed 's/^manifest|1|preview|/manifest|1|stable|/' "$manifest" > "$stable_manifest"
(
    cd "$api_payload"
    sha256sum ssclash-party-stable-manifest > \
        ssclash-party-stable-manifest.sha256
)
printf '%s\n' \
    '{"assets":[{"browser_download_url":"https://github.com/ponkcore/SSClash-PARTY/releases/download/v4.7.0-party.5/ssclash-party-stable-manifest"}]}' \
    > "$api_payload/latest"
output=$("${base_environment[@]}" \
    SSCLASH_PARTY_CHANNEL=stable \
    SSCLASH_PARTY_TEST_MANIFEST= \
    SSCLASH_PARTY_TEST_PAYLOAD_DIR="$api_payload" \
    sh "$installer" check 2>&1)
assert_contains "$output" '/v4.7.0-party.5/ssclash-party-stable-manifest'
assert_contains "$output" 'SSCLASH_PARTY_UPDATE|none|4.7.0-party.5|update-available'

output=$("${base_environment[@]}" \
    SSCLASH_PARTY_TEST_INSTALLED_PACKAGES=luci-app-ssclash \
    SSCLASH_PARTY_TEST_CURRENT_PARTY_VERSION=4.7.0-party.5 \
    SSCLASH_PARTY_TEST_MERGER_PRESENT=1 \
    SSCLASH_PARTY_TEST_CORE_PRESENT=1 \
    "SSCLASH_PARTY_TEST_CORE_VERSION=Mihomo Meta v1.19.29" \
    SSCLASH_PARTY_TEST_OVERLAY_FREE_KIB=1 \
    SSCLASH_PARTY_TEST_TMP_FREE_KIB=1024 \
    sh "$installer" install --yes 2>&1)
assert_contains "$output" 'already installed; no changes are required.'

output=$("${base_environment[@]}" \
    SSCLASH_PARTY_TEST_INSTALLED_PACKAGES=luci-app-ssclash \
    SSCLASH_PARTY_TEST_CURRENT_PARTY_VERSION=4.7.0-party.6 \
    SSCLASH_PARTY_TEST_MERGER_PRESENT=1 \
    SSCLASH_PARTY_TEST_CORE_PRESENT=1 \
    "SSCLASH_PARTY_TEST_CORE_VERSION=Mihomo Meta v1.19.29" \
    sh "$installer" install --yes 2>&1)
assert_contains "$output" 'newer than this channel; no downgrade was performed.'

tampered_manifest="$temporary/tampered.manifest"
cp "$manifest" "$tampered_manifest"
original_manifest_hash=$(sha256sum "$manifest" | awk '{ print $1 }')
printf '%s  tampered.manifest\n' "$original_manifest_hash" > "${tampered_manifest}.sha256"
printf '\n# tampered\n' >> "$tampered_manifest"
if output=$("${base_environment[@]}" \
    "SSCLASH_PARTY_TEST_MANIFEST=file://$tampered_manifest" \
    sh "$installer" doctor 2>&1); then
    fail 'tampered manifest unexpectedly passed'
fi
assert_contains "$output" 'SHA-256 verification failed for tampered.manifest'

duplicate_manifest="$temporary/duplicate.manifest"
cp "$manifest" "$duplicate_manifest"
grep '^package|25.12.5|mediatek/filogic|' "$manifest" >> "$duplicate_manifest"
(
    cd "$temporary"
    sha256sum duplicate.manifest > duplicate.manifest.sha256
)
if output=$("${base_environment[@]}" \
    "SSCLASH_PARTY_TEST_MANIFEST=file://$duplicate_manifest" \
    sh "$installer" doctor 2>&1); then
    fail 'duplicate matching package unexpectedly passed'
fi
assert_contains "$output" 'duplicate matching packages'

extra_field_manifest="$temporary/extra-field.manifest"
awk '
    /^package\|25\.12\.5\|mediatek\/filogic\|/ { print $0 "|unexpected"; next }
    { print }
' "$manifest" > "$extra_field_manifest"
(
    cd "$temporary"
    sha256sum extra-field.manifest > extra-field.manifest.sha256
)
if output=$("${base_environment[@]}" \
    "SSCLASH_PARTY_TEST_MANIFEST=file://$extra_field_manifest" \
    sh "$installer" doctor 2>&1); then
    fail 'manifest package with an extra field unexpectedly passed'
fi
assert_contains "$output" 'Malformed package record in manifest'

unsafe_tag_manifest="$temporary/unsafe-tag.manifest"
sed 's/^manifest|1|preview|[^|]*|/manifest|1|preview|v4.7.0-party.5;unsafe|/' \
    "$manifest" > "$unsafe_tag_manifest"
(
    cd "$temporary"
    sha256sum unsafe-tag.manifest > unsafe-tag.manifest.sha256
)
if output=$("${base_environment[@]}" \
    "SSCLASH_PARTY_TEST_MANIFEST=file://$unsafe_tag_manifest" \
    sh "$installer" doctor 2>&1); then
    fail 'unsafe release tag unexpectedly passed'
fi
assert_contains "$output" 'Invalid PARTY release tag in manifest'

dist="$temporary/dist"
mkdir -p "$dist"
packages=(
    luci-app-ssclash-4.7.0-r14-openwrt-25.12.5-mediatek-filogic-aarch64_cortex-a53.apk
    luci-app-ssclash-4.7.0-r14-openwrt-25.12.5-x86-64-x86_64.apk
    luci-app-ssclash_4.7.0-r14_x86_64-openwrt-24.10.8-x86-64-x86_64.ipk
)
for package in "${packages[@]}"; do
    printf 'fixture for %s\n' "$package" > "$dist/$package"
    (
        cd "$dist"
        sha256sum "$package" > "$package.sha256"
    )
done

generated_manifest="$temporary/ssclash-party-preview-manifest"
"$generator" "$dist" v4.7.0-party.12 preview "$generated_manifest"
(
    cd "$temporary"
    sha256sum --check --strict ssclash-party-preview-manifest.sha256 >/dev/null
)
grep -Fq 'manifest|1|preview|v4.7.0-party.12|4.7.0-party.12' "$generated_manifest" || \
    fail 'generated manifest metadata is wrong'
[[ $(grep -c '^package|' "$generated_manifest") -eq 3 ]] || \
    fail 'generated manifest does not contain three packages'
[[ $(grep -c '^core|' "$generated_manifest") -eq 2 ]] || \
    fail 'generated manifest does not contain two Mihomo cores'

bad_sidecar_dist="$temporary/bad-sidecar-dist"
cp -R "$dist" "$bad_sidecar_dist"
printf '%s\n' 'unexpected second record' >> \
    "$bad_sidecar_dist/${packages[0]}.sha256"
if "$generator" "$bad_sidecar_dist" v4.7.0-party.12 preview \
    "$temporary/bad-sidecar.manifest" >/dev/null 2>&1; then
    fail 'manifest generator accepted a multi-record package sidecar'
fi

install_root="$temporary/install-root"
payload_dir="$temporary/payload"
fake_bin="$temporary/fake-bin"
command_log="$temporary/package-manager.log"
mkdir -p "$install_root" "$payload_dir" "$fake_bin"

cudy_package=${packages[0]}
cp "$dist/$cudy_package" "$payload_dir/$cudy_package"
cp "$dist/$cudy_package.sha256" "$payload_dir/$cudy_package.sha256"

fake_core="$temporary/fake-mihomo"
cat > "$fake_core" <<'EOF'
#!/bin/sh
case "${1:-}" in
    -v)
        echo 'Mihomo Meta v1.19.29 fixture'
        exit 0
        ;;
    -t)
        exit 0
        ;;
esac
exit 0
EOF
chmod +x "$fake_core"
gzip -c "$fake_core" > "$payload_dir/mihomo-linux-arm64-v1.19.29.gz"
fake_core_hash=$(sha256sum "$payload_dir/mihomo-linux-arm64-v1.19.29.gz" | awk '{ print $1 }')
fake_core_size=$(wc -c < "$payload_dir/mihomo-linux-arm64-v1.19.29.gz" | awk '{ print $1 }')

install_manifest="$temporary/install.manifest"
awk -F '|' -v OFS='|' -v hash="$fake_core_hash" -v size="$fake_core_size" '
    $1 == "core" && $2 == "arm64" {
        $5 = hash
        $6 = size
    }
    { print }
' "$generated_manifest" > "$install_manifest"
(
    cd "$temporary"
    sha256sum install.manifest > install.manifest.sha256
)

cat > "$fake_bin/apk" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SSCLASH_PARTY_TEST_COMMAND_LOG"
[[ ${1:-} == update ]] && exit 0

simulate=0
for argument in "$@"; do
    [[ $argument == --simulate ]] && simulate=1
done
[[ $simulate -eq 1 ]] && exit 0

mkdir -p \
    "$SSCLASH_PARTY_ROOT/usr/share/ssclash-party" \
    "$SSCLASH_PARTY_ROOT/usr/bin"
printf '%s\n' '4.7.0-party.12' > \
    "$SSCLASH_PARTY_ROOT/usr/share/ssclash-party/VERSION"
cat > "$SSCLASH_PARTY_ROOT/usr/bin/ssclash-profile-merge" <<'MERGER'
#!/bin/sh
exit 0
MERGER
chmod +x "$SSCLASH_PARTY_ROOT/usr/bin/ssclash-profile-merge"
EOF
chmod +x "$fake_bin/apk"

if ! output=$(env PATH="$fake_bin:$PATH" \
    SSCLASH_PARTY_TESTING=1 \
    SSCLASH_PARTY_ROOT="$install_root" \
    SSCLASH_PARTY_TEST_RELEASE=25.12.5 \
    SSCLASH_PARTY_TEST_TARGET=mediatek/filogic \
    SSCLASH_PARTY_TEST_ARCH=aarch64_cortex-a53 \
    SSCLASH_PARTY_TEST_BOARD=cudy,wbr3000uax-v1-ubootmod \
    SSCLASH_PARTY_TEST_MODEL='Cudy WBR3000UAX' \
    SSCLASH_PARTY_TEST_PACKAGE_MANAGER=apk \
    SSCLASH_PARTY_TEST_FIREWALL=fw4 \
    SSCLASH_PARTY_TEST_MEMORY_KIB=524288 \
    SSCLASH_PARTY_TEST_OVERLAY_FREE_KIB=131072 \
    SSCLASH_PARTY_TEST_TMP_FREE_KIB=262144 \
    SSCLASH_PARTY_CHANNEL=preview \
    "SSCLASH_PARTY_TEST_MANIFEST=file://$install_manifest" \
    SSCLASH_PARTY_TEST_PAYLOAD_DIR="$payload_dir" \
    SSCLASH_PARTY_TEST_COMMAND_LOG="$command_log" \
    sh "$installer" install --yes 2>&1); then
    fail "full installation fixture failed:\n$output"
fi
assert_contains "$output" 'SSClash PARTY installation completed successfully.'
[[ -x "$install_root/opt/clash/bin/clash" ]] || fail 'fixture Mihomo was not installed'
[[ -x "$install_root/usr/bin/ssclash-profile-merge" ]] || fail 'fixture PARTY package was not installed'
grep -Fxq 'update' "$command_log" || fail 'apk update was not requested'
grep -Fq 'add --simulate --allow-untrusted --force-reinstall' "$command_log" || \
    fail 'apk force-reinstall simulation was not requested'
grep -Fq 'add --allow-untrusted --force-reinstall' "$command_log" || \
    fail 'apk force-reinstall installation was not requested'

echo 'Installer tests passed.'
