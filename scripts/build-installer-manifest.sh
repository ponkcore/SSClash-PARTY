#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 4 ]]; then
    echo "usage: $0 DIST_DIR RELEASE_TAG CHANNEL OUTPUT" >&2
    exit 2
fi

dist_dir=$1
release_tag=$2
channel=$3
output=$4
repository_root=$(cd "$(dirname "$0")/.." && pwd)
party_version=$(<"$repository_root/luci-app-ssclash/rootfs/usr/share/ssclash-party/VERSION")

case "$channel" in
    preview|stable) ;;
    *)
        echo "unsupported installer channel: $channel" >&2
        exit 1
        ;;
esac

if [[ "v$party_version" != "$release_tag" ]]; then
    echo "release tag $release_tag does not match embedded PARTY version $party_version" >&2
    exit 1
fi

find_one_package() {
    local pattern=$1
    local matches=()

    mapfile -t matches < <(find "$dist_dir" -maxdepth 1 -type f -name "$pattern" -print | sort)
    if [[ ${#matches[@]} -ne 1 ]]; then
        echo "expected one package matching $pattern, found ${#matches[@]}" >&2
        exit 1
    fi
    printf '%s' "${matches[0]}"
}

verified_package_hash() {
    local package=$1
    local sidecar="${package}.sha256"
    local package_dir package_name hash declared_hash declared_name extra

    [[ -f "$sidecar" ]] || {
        echo "missing checksum sidecar: $sidecar" >&2
        exit 1
    }
    package_dir=$(dirname "$package")
    package_name=$(basename "$package")
    read -r declared_hash declared_name extra < "$sidecar"
    declared_name=${declared_name#\*}
    [[ $declared_hash =~ ^[0-9a-f]{64}$ ]] || {
        echo "invalid checksum in sidecar: $sidecar" >&2
        exit 1
    }
    [[ $declared_name == "$package_name" && -z $extra ]] || {
        echo "checksum sidecar does not name $package_name" >&2
        exit 1
    }
    [[ $(wc -l < "$sidecar") -eq 1 ]] || {
        echo "checksum sidecar must contain exactly one record: $sidecar" >&2
        exit 1
    }
    (
        cd "$package_dir"
        sha256sum --check --strict "${package_name}.sha256" >/dev/null
    )
    hash=$(sha256sum "$package" | awk '{ print $1 }')
    [[ $hash =~ ^[0-9a-f]{64}$ ]] || {
        echo "invalid SHA-256 for $package_name" >&2
        exit 1
    }
    [[ $hash == "$declared_hash" ]] || {
        echo "checksum mismatch for $package_name" >&2
        exit 1
    }
    printf '%s' "$hash"
}

apk_cudy=$(find_one_package '*-openwrt-25.12.5-mediatek-filogic-aarch64_cortex-a53.apk')
apk_x86=$(find_one_package '*-openwrt-25.12.5-x86-64-x86_64.apk')
ipk_x86=$(find_one_package '*-openwrt-24.10.8-x86-64-x86_64.ipk')

apk_cudy_hash=$(verified_package_hash "$apk_cudy")
apk_x86_hash=$(verified_package_hash "$apk_x86")
ipk_x86_hash=$(verified_package_hash "$ipk_x86")

output_dir=$(dirname "$output")
output_name=$(basename "$output")
mkdir -p "$output_dir"
temporary=$(mktemp "$output_dir/.${output_name}.XXXXXX")
trap 'rm -f "$temporary"' EXIT

{
    echo '# SSClash PARTY installer manifest. Fields are pipe-delimited and never sourced.'
    printf 'manifest|1|%s|%s|%s\n' "$channel" "$release_tag" "$party_version"
    printf 'package|25.12.5|mediatek/filogic|aarch64_cortex-a53|apk|%s|%s|70000|40000|131072|fw4|ci-and-live-tested|cudy,wbr3000uax-v1-ubootmod\n' \
        "$(basename "$apk_cudy")" "$apk_cudy_hash"
    printf 'package|25.12.5|x86/64|x86_64|apk|%s|%s|70000|40000|131072|fw4|ci-tested|\n' \
        "$(basename "$apk_x86")" "$apk_x86_hash"
    printf 'package|24.10.8|x86/64|x86_64|ipk|%s|%s|70000|40000|131072|fw4|ci-tested|\n' \
        "$(basename "$ipk_x86")" "$ipk_x86_hash"
    echo 'core|arm64|v1.19.29|mihomo-linux-arm64-v1.19.29.gz|9a868b5e4e0ad91d9d71e1b41b0cfce78aaba44360c30df74a723f8e3926a86c|16051759'
    echo 'core|amd64-compatible|v1.19.29|mihomo-linux-amd64-compatible-v1.19.29.gz|5612e698e96c8b8ad15abc4c0a4f098eba9234354b4f248cb97f2528e215b094|17881563'
} > "$temporary"

mv "$temporary" "$output"
trap - EXIT
(
    cd "$output_dir"
    sha256sum "$output_name" > "${output_name}.sha256"
)
