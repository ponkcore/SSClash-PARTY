#!/bin/sh

# SSClash PARTY safe installer for OpenWrt.
#
# The installer only accepts an exact release/target/architecture/package
# match from a verified PARTY manifest. It never flashes firmware, removes a
# competing proxy stack, or starts Clash on a first installation.

INSTALLER_VERSION="1.0.0"
PARTY_REPOSITORY="ponkcore/SSClash-PARTY"
PARTY_REPOSITORY_URL="https://github.com/${PARTY_REPOSITORY}"
PARTY_API_URL="https://api.github.com/repos/${PARTY_REPOSITORY}"
PARTY_RAW_URL="${SSCLASH_PARTY_RAW_URL:-https://raw.githubusercontent.com/${PARTY_REPOSITORY}/party}"
MIHOMO_REPOSITORY_URL="https://github.com/MetaCubeX/mihomo"

COMMAND="install"
CHANNEL="${SSCLASH_PARTY_CHANNEL:-stable}"
ASSUME_YES=0
DRY_RUN=0
NO_CORE=0
ALLOW_PACKAGE_MIGRATION=0
MUTATION_STARTED=0
WORK_DIR=""
RECOVERY_ARCHIVE=""
TESTING="${SSCLASH_PARTY_TESTING:-0}"
ROOT_PREFIX="${SSCLASH_PARTY_ROOT:-}"

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    COLOR_RED=$(printf '\033[0;31m')
    COLOR_GREEN=$(printf '\033[0;32m')
    COLOR_YELLOW=$(printf '\033[1;33m')
    COLOR_CYAN=$(printf '\033[0;36m')
    COLOR_BOLD=$(printf '\033[1m')
    COLOR_RESET=$(printf '\033[0m')
else
    COLOR_RED=''
    COLOR_GREEN=''
    COLOR_YELLOW=''
    COLOR_CYAN=''
    COLOR_BOLD=''
    COLOR_RESET=''
fi

log() {
    printf '%s[+]%s %s\n' "$COLOR_GREEN" "$COLOR_RESET" "$*"
}

info() {
    printf '%s[i]%s %s\n' "$COLOR_CYAN" "$COLOR_RESET" "$*"
}

warn() {
    printf '%s[!]%s %s\n' "$COLOR_YELLOW" "$COLOR_RESET" "$*" >&2
}

die() {
    printf '%s[x] %s%s\n' "$COLOR_RED" "$*" "$COLOR_RESET" >&2
    if [ "$MUTATION_STARTED" -eq 0 ]; then
        printf 'Nothing was changed.\n' >&2
    fi
    exit 1
}

separator() {
    printf '%s%s%s\n' "$COLOR_CYAN" '----------------------------------------' "$COLOR_RESET"
}

usage() {
    cat <<'EOF'
SSClash PARTY safe installer for OpenWrt

Usage:
  sh install-ssclash.sh doctor [--channel stable|preview]
  sh install-ssclash.sh check [--channel stable|preview]
  sh install-ssclash.sh install [options]
  sh install-ssclash.sh upgrade [options]

Commands:
  doctor     Read-only compatibility and conflict check.
  check      Read-only check with a final machine-readable update record.
  install    Install PARTY, or safely update an existing installation.
  upgrade    Require an existing PARTY installation, then update it.

Options:
  --yes                       Do not ask for the final confirmation.
  --dry-run                   Print the installation plan without changing it.
  --no-core                   Do not install Mihomo when it is missing.
  --allow-package-migration   Permit unattended replacement of a non-PARTY package.
  --channel NAME              Select stable or preview (default: stable).
  --help                      Show this help.

The installer never flashes OpenWrt and never removes competing proxy tools.
EOF
}

cleanup() {
    if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
        rm -rf "$WORK_DIR"
    fi
}

trap cleanup 0
trap 'exit 130' HUP INT TERM

root_path() {
    printf '%s%s' "$ROOT_PREFIX" "$1"
}

append_line() {
    if [ -n "$1" ]; then
        printf '%s\n%s' "$1" "$2"
    else
        printf '%s' "$2"
    fi
}

is_uint() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

is_sha256() {
    [ "${#1}" -eq 64 ] || return 1
    case "$1" in
        *[!0-9a-f]*) return 1 ;;
        *) return 0 ;;
    esac
}

is_safe_asset_name() {
    case "$1" in
        ''|*/*|*[!A-Za-z0-9._-]*) return 1 ;;
        *) return 0 ;;
    esac
}

is_party_version() {
    printf '%s\n' "$1" | grep -Eq '^[0-9]+(\.[0-9]+)*-party\.[0-9]+$'
}

party_version_compare() {
    awk -v left="$1" -v right="$2" 'BEGIN {
        sub(/-party[.]/, ".", left)
        sub(/-party[.]/, ".", right)
        left_count = split(left, left_parts, ".")
        right_count = split(right, right_parts, ".")
        count = left_count > right_count ? left_count : right_count
        for (part_index = 1; part_index <= count; part_index++) {
            left_value = part_index <= left_count ? left_parts[part_index] + 0 : 0
            right_value = part_index <= right_count ? right_parts[part_index] + 0 : 0
            if (left_value < right_value) { print -1; exit }
            if (left_value > right_value) { print 1; exit }
        }
        print 0
    }'
}

parse_arguments() {
    if [ "$#" -gt 0 ]; then
        case "$1" in
            doctor|check|install|upgrade)
                COMMAND="$1"
                shift
                ;;
        esac
    fi

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --yes)
                ASSUME_YES=1
                ;;
            --dry-run)
                DRY_RUN=1
                ;;
            --no-core)
                NO_CORE=1
                ;;
            --allow-package-migration)
                ALLOW_PACKAGE_MIGRATION=1
                ;;
            --channel)
                shift
                [ "$#" -gt 0 ] || die '--channel requires a value'
                CHANNEL="$1"
                ;;
            --channel=*)
                CHANNEL=${1#*=}
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                usage >&2
                die "Unknown argument: $1"
                ;;
        esac
        shift
    done

    case "$CHANNEL" in
        preview|stable) ;;
        *) die "Unsupported release channel: $CHANNEL" ;;
    esac
}

make_work_dir() {
    [ -n "$WORK_DIR" ] && return 0
    umask 077
    WORK_DIR=$(mktemp -d /tmp/ssclash-party-installer.XXXXXX 2>/dev/null) || {
        WORK_DIR="/tmp/ssclash-party-installer.$$"
        mkdir "$WORK_DIR" || die 'Could not create a temporary directory'
    }
}

release_field() {
    field_name="$1"
    release_file="$2"
    sed -n "s/^${field_name}=['\"]\([^'\"]*\)['\"]$/\1/p" "$release_file" | head -n 1
}

detect_board_value() {
    key="$1"
    fallback_file="$2"
    value=''

    if [ -r "$fallback_file" ]; then
        value=$(sed -n '1p' "$fallback_file" 2>/dev/null || true)
    fi

    if [ -z "$value" ] && [ -z "$ROOT_PREFIX" ] && command -v ubus >/dev/null 2>&1; then
        board_json=$(ubus call system board 2>/dev/null || true)
        if [ -n "$board_json" ] && command -v jsonfilter >/dev/null 2>&1; then
            value=$(printf '%s\n' "$board_json" | jsonfilter -e "@.${key}" 2>/dev/null || true)
        fi
        if [ -z "$value" ]; then
            value=$(printf '%s\n' "$board_json" |
                sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" |
                head -n 1)
        fi
    fi

    printf '%s' "$value"
}

detect_package_manager() {
    if [ "$TESTING" = '1' ]; then
        printf '%s' "${SSCLASH_PARTY_TEST_PACKAGE_MANAGER:-}"
        return 0
    fi

    apk_root=$(root_path /etc/apk)
    opkg_root=$(root_path /etc/opkg)
    if command -v apk >/dev/null 2>&1 && [ -d "$apk_root" ]; then
        printf 'apk'
    elif command -v opkg >/dev/null 2>&1 && [ -d "$opkg_root" ]; then
        printf 'opkg'
    else
        printf ''
    fi
}

detect_firewall() {
    if [ "$TESTING" = '1' ]; then
        printf '%s' "${SSCLASH_PARTY_TEST_FIREWALL:-unknown}"
        return 0
    fi

    if command -v fw4 >/dev/null 2>&1 || [ -x "$(root_path /sbin/fw4)" ]; then
        printf 'fw4'
    elif command -v iptables >/dev/null 2>&1; then
        printf 'iptables'
    else
        printf 'unknown'
    fi
}

detect_free_kib() {
    requested_path="$1"
    fallback_path="$2"
    output=$(df -Pk "$requested_path" 2>/dev/null | awk 'END { print $4 }')
    if ! is_uint "$output"; then
        output=$(df -Pk "$fallback_path" 2>/dev/null | awk 'END { print $4 }')
    fi
    printf '%s' "$output"
}

load_installed_packages() {
    if [ "$TESTING" = '1' ]; then
        INSTALLED_PACKAGES=${SSCLASH_PARTY_TEST_INSTALLED_PACKAGES:-}
        return 0
    fi

    case "$PACKAGE_MANAGER" in
        apk)
            INSTALLED_PACKAGES=$(apk info 2>/dev/null || true)
            ;;
        opkg)
            INSTALLED_PACKAGES=$(opkg list-installed 2>/dev/null | awk '{ print $1 }' || true)
            ;;
        *)
            INSTALLED_PACKAGES=''
            ;;
    esac
}

package_is_installed() {
    printf '%s\n' "$INSTALLED_PACKAGES" | grep -Fxq "$1"
}

detect_system() {
    if [ "$TESTING" = '1' ]; then
        OPENWRT_RELEASE=${SSCLASH_PARTY_TEST_RELEASE:-}
        OPENWRT_TARGET=${SSCLASH_PARTY_TEST_TARGET:-}
        OPENWRT_ARCH=${SSCLASH_PARTY_TEST_ARCH:-}
        BOARD_NAME=${SSCLASH_PARTY_TEST_BOARD:-unknown}
        BOARD_MODEL=${SSCLASH_PARTY_TEST_MODEL:-unknown}
        PACKAGE_MANAGER=$(detect_package_manager)
        FIREWALL_BACKEND=$(detect_firewall)
        MEMORY_KIB=${SSCLASH_PARTY_TEST_MEMORY_KIB:-0}
        OVERLAY_FREE_KIB=${SSCLASH_PARTY_TEST_OVERLAY_FREE_KIB:-0}
        TMP_FREE_KIB=${SSCLASH_PARTY_TEST_TMP_FREE_KIB:-0}
        CURRENT_PARTY_VERSION=${SSCLASH_PARTY_TEST_CURRENT_PARTY_VERSION:-}
        MERGER_PRESENT=${SSCLASH_PARTY_TEST_MERGER_PRESENT:-0}
        CORE_PRESENT=${SSCLASH_PARTY_TEST_CORE_PRESENT:-0}
        CORE_VERSION_TEXT=${SSCLASH_PARTY_TEST_CORE_VERSION:-}
        CLASH_ENABLED_BEFORE=${SSCLASH_PARTY_TEST_CLASH_ENABLED:-0}
        CLASH_RUNNING_BEFORE=${SSCLASH_PARTY_TEST_CLASH_RUNNING:-0}
        load_installed_packages
        return 0
    fi

    release_file=$(root_path /etc/openwrt_release)
    [ -r "$release_file" ] || die 'This does not look like an OpenWrt system'

    OPENWRT_RELEASE=$(release_field DISTRIB_RELEASE "$release_file")
    OPENWRT_TARGET=$(release_field DISTRIB_TARGET "$release_file")
    OPENWRT_ARCH=$(release_field DISTRIB_ARCH "$release_file")
    [ -n "$OPENWRT_RELEASE" ] || die 'DISTRIB_RELEASE is missing from /etc/openwrt_release'
    [ -n "$OPENWRT_TARGET" ] || die 'DISTRIB_TARGET is missing from /etc/openwrt_release'
    [ -n "$OPENWRT_ARCH" ] || die 'DISTRIB_ARCH is missing from /etc/openwrt_release'

    BOARD_NAME=$(detect_board_value board_name "$(root_path /tmp/sysinfo/board_name)")
    BOARD_MODEL=$(detect_board_value model "$(root_path /tmp/sysinfo/model)")
    [ -n "$BOARD_NAME" ] || BOARD_NAME='unknown'
    [ -n "$BOARD_MODEL" ] || BOARD_MODEL='unknown'

    PACKAGE_MANAGER=$(detect_package_manager)
    [ -n "$PACKAGE_MANAGER" ] || die 'Neither the OpenWrt apk nor opkg package manager was detected'
    FIREWALL_BACKEND=$(detect_firewall)

    meminfo_file=$(root_path /proc/meminfo)
    MEMORY_KIB=$(awk '/^MemTotal:/ { print $2; exit }' "$meminfo_file" 2>/dev/null || true)
    is_uint "$MEMORY_KIB" || MEMORY_KIB=0

    overlay_path=$(root_path /overlay)
    root_fs_path=$(root_path /)
    tmp_path=$(root_path /tmp)
    OVERLAY_FREE_KIB=$(detect_free_kib "$overlay_path" "$root_fs_path")
    TMP_FREE_KIB=$(detect_free_kib "$tmp_path" "$root_fs_path")
    is_uint "$OVERLAY_FREE_KIB" || OVERLAY_FREE_KIB=0
    is_uint "$TMP_FREE_KIB" || TMP_FREE_KIB=0

    load_installed_packages

    party_version_file=$(root_path /usr/share/ssclash-party/VERSION)
    CURRENT_PARTY_VERSION=''
    if [ -r "$party_version_file" ]; then
        CURRENT_PARTY_VERSION=$(sed -n '1p' "$party_version_file" 2>/dev/null || true)
    fi
    MERGER_PRESENT=0
    [ -x "$(root_path /usr/bin/ssclash-profile-merge)" ] && MERGER_PRESENT=1

    clash_bin=$(root_path /opt/clash/bin/clash)
    CORE_PRESENT=0
    CORE_VERSION_TEXT=''
    if [ -x "$clash_bin" ]; then
        CORE_VERSION_TEXT=$("$clash_bin" -v 2>/dev/null | head -n 1 || true)
        [ -n "$CORE_VERSION_TEXT" ] && CORE_PRESENT=1
    fi

    CLASH_ENABLED_BEFORE=0
    CLASH_RUNNING_BEFORE=0
    clash_init=$(root_path /etc/init.d/clash)
    if [ -z "$ROOT_PREFIX" ] && [ -x "$clash_init" ]; then
        "$clash_init" enabled >/dev/null 2>&1 && CLASH_ENABLED_BEFORE=1
        "$clash_init" status >/dev/null 2>&1 && CLASH_RUNNING_BEFORE=1
    fi
}

print_system_summary() {
    separator
    printf '  %sSSClash PARTY device report%s\n' "$COLOR_BOLD" "$COLOR_RESET"
    separator
    info "Installer:       ${INSTALLER_VERSION}"
    info "OpenWrt:        ${OPENWRT_RELEASE}"
    info "Board:          ${BOARD_NAME}"
    info "Model:          ${BOARD_MODEL}"
    info "Target:         ${OPENWRT_TARGET}"
    info "Architecture:   ${OPENWRT_ARCH}"
    info "Package manager: ${PACKAGE_MANAGER}"
    info "Firewall:       ${FIREWALL_BACKEND}"
    info "Memory:         ${MEMORY_KIB} KiB"
    info "Overlay free:   ${OVERLAY_FREE_KIB} KiB"
    info "Temporary free: ${TMP_FREE_KIB} KiB"
    if [ -n "$CURRENT_PARTY_VERSION" ]; then
        info "Installed PARTY:${CURRENT_PARTY_VERSION}"
    elif package_is_installed luci-app-ssclash; then
        info 'Installed PARTY:no (a non-PARTY package is installed)'
    else
        info 'Installed PARTY:no'
    fi
    if [ "$CORE_PRESENT" -eq 1 ]; then
        info "Mihomo:         ${CORE_VERSION_TEXT}"
    else
        info 'Mihomo:         missing or not executable'
    fi
}

try_download() {
    download_url="$1"
    download_destination="$2"
    rm -f "$download_destination"

    if [ "$TESTING" = '1' ]; then
        case "$download_url" in
            file://*) cp "${download_url#file://}" "$download_destination" 2>/dev/null || return 1 ;;
            /*) cp "$download_url" "$download_destination" 2>/dev/null || return 1 ;;
            https://*)
                [ -n "${SSCLASH_PARTY_TEST_PAYLOAD_DIR:-}" ] || return 1
                cp "${SSCLASH_PARTY_TEST_PAYLOAD_DIR}/$(basename "$download_url")" \
                    "$download_destination" 2>/dev/null || return 1
                ;;
            *) return 1 ;;
        esac
    else
        case "$download_url" in
            https://*) ;;
            *) return 1 ;;
        esac

        if command -v uclient-fetch >/dev/null 2>&1; then
            uclient-fetch -q -O "$download_destination" "$download_url" >/dev/null 2>&1 || return 1
        elif command -v wget >/dev/null 2>&1; then
            wget -q -O "$download_destination" "$download_url" >/dev/null 2>&1 || return 1
        elif command -v curl >/dev/null 2>&1; then
            curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 \
                "$download_url" -o "$download_destination" >/dev/null 2>&1 || return 1
        else
            return 1
        fi
    fi

    [ -s "$download_destination" ]
}

download_required() {
    try_download "$1" "$2" || die "Download failed: $1"
}

sha256_file() {
    sha256sum "$1" 2>/dev/null | awk '{ print $1 }'
}

file_size_bytes() {
    wc -c < "$1" | awk '{ print $1 }'
}

verify_sidecar() {
    payload="$1"
    sidecar="$2"
    expected_name="$3"

    sidecar_hash=$(awk 'NR == 1 { print $1 }' "$sidecar")
    sidecar_name=$(awk 'NR == 1 { print $2 }' "$sidecar")
    sidecar_name=${sidecar_name#\*}
    is_sha256 "$sidecar_hash" || die "Invalid checksum sidecar for ${expected_name}"
    [ "$sidecar_name" = "$expected_name" ] || die "Checksum sidecar names ${sidecar_name}, expected ${expected_name}"

    actual_hash=$(sha256_file "$payload")
    [ "$actual_hash" = "$sidecar_hash" ] || die "SHA-256 verification failed for ${expected_name}"
    VERIFIED_SHA256="$actual_hash"
}

discover_manifest() {
    make_work_dir
    manifest_file="$WORK_DIR/manifest"
    manifest_sidecar="$WORK_DIR/manifest.sha256"

    if [ "$TESTING" = '1' ] && [ -n "${SSCLASH_PARTY_TEST_MANIFEST:-}" ]; then
        manifest_url=${SSCLASH_PARTY_TEST_MANIFEST}
        manifest_name=$(basename "$manifest_url")
        manifest_sidecar_url="${manifest_url}.sha256"
    else
        api_file="$WORK_DIR/releases.json"
        manifest_url=''
        release_manifest_name="ssclash-party-${CHANNEL}-manifest"
        if [ "$CHANNEL" = 'stable' ]; then
            api_url="${PARTY_API_URL}/releases/latest"
        else
            api_url="${PARTY_API_URL}/releases?per_page=20"
        fi

        if try_download "$api_url" "$api_file"; then
            manifest_url=$(tr ',' '\n' < "$api_file" |
                sed -n "s#.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*/${release_manifest_name}\)\".*#\1#p" |
                head -n 1)
        fi

        if [ -z "$manifest_url" ] && [ "$CHANNEL" = 'preview' ]; then
            manifest_url="${PARTY_RAW_URL}/installer/channels/preview.manifest"
        fi
        [ -n "$manifest_url" ] || die "No ${CHANNEL} release manifest is available"

        case "$manifest_url" in
            "${PARTY_REPOSITORY_URL}"/releases/download/*/"$release_manifest_name")
                manifest_name="$release_manifest_name"
                ;;
            "${PARTY_RAW_URL}"/installer/channels/preview.manifest)
                manifest_name='preview.manifest'
                ;;
            *)
                die "Rejected untrusted manifest URL: $manifest_url"
                ;;
        esac
        manifest_sidecar_url="${manifest_url}.sha256"
    fi

    download_required "$manifest_url" "$manifest_file"
    download_required "$manifest_sidecar_url" "$manifest_sidecar"
    verify_sidecar "$manifest_file" "$manifest_sidecar" "$manifest_name"
    MANIFEST_SOURCE="$manifest_url"
    MANIFEST_FILE="$manifest_file"
}

validate_manager_architecture() {
    if [ "$PACKAGE_MANAGER" = 'apk' ]; then
        case "$OPENWRT_ARCH" in
            aarch64_*) expected_manager_arch='aarch64' ;;
            x86_64) expected_manager_arch='x86_64' ;;
            *) die "No trusted apk architecture mapping exists for ${OPENWRT_ARCH}" ;;
        esac
        if [ "$TESTING" = '1' ]; then
            manager_arch=${SSCLASH_PARTY_TEST_MANAGER_ARCH:-$expected_manager_arch}
        else
            manager_arch=$(apk --print-arch 2>/dev/null | head -n 1 || true)
        fi
        [ -n "$manager_arch" ] || die 'apk did not report its native architecture'
        if [ "$manager_arch" != "$expected_manager_arch" ]; then
            die "apk reports architecture ${manager_arch}, expected ${expected_manager_arch} for OpenWrt package architecture ${OPENWRT_ARCH}"
        fi
    elif [ "$TESTING" = '1' ]; then
        manager_arch=${SSCLASH_PARTY_TEST_MANAGER_ARCH:-$OPENWRT_ARCH}
        [ "$manager_arch" = "$OPENWRT_ARCH" ] ||
            die "opkg does not accept the reported architecture ${OPENWRT_ARCH}"
    elif ! opkg print-architecture 2>/dev/null |
        awk -v wanted="$OPENWRT_ARCH" '$2 == wanted { found = 1 } END { exit !found }'; then
            die "opkg does not accept the reported architecture ${OPENWRT_ARCH}"
    fi
}

parse_manifest() {
    MANIFEST_VERSION=''
    MANIFEST_CHANNEL=''
    MANIFEST_TAG=''
    MANIFEST_PARTY_VERSION=''
    PACKAGE_MATCHES=0
    CORE_MATCHES=0
    SUPPORTED_SYSTEMS=''

    case "$OPENWRT_ARCH" in
        aarch64_*) MIHOMO_ARCH='arm64' ;;
        x86_64) MIHOMO_ARCH='amd64-compatible' ;;
        *) MIHOMO_ARCH='' ;;
    esac
    [ -n "$MIHOMO_ARCH" ] || die "No trusted Mihomo mapping exists for ${OPENWRT_ARCH}"

    while IFS='|' read -r record f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12 f13 extra; do
        case "$record" in
            ''|'#'*) continue ;;
            manifest)
                [ -z "$f5$f6$f7$f8$f9$f10$f11$f12$f13$extra" ] || die 'Malformed manifest metadata record'
                [ -z "$MANIFEST_VERSION" ] || die 'Duplicate manifest metadata record'
                MANIFEST_VERSION="$f1"
                MANIFEST_CHANNEL="$f2"
                MANIFEST_TAG="$f3"
                MANIFEST_PARTY_VERSION="$f4"
                ;;
            package)
                [ -z "$f13$extra" ] || die 'Malformed package record in manifest'
                is_safe_asset_name "$f5" || die 'Unsafe package asset name in manifest'
                is_sha256 "$f6" || die 'Invalid package SHA-256 in manifest'
                is_uint "$f7" || die 'Invalid package overlay requirement in manifest'
                is_uint "$f8" || die 'Invalid package temporary-space requirement in manifest'
                is_uint "$f9" || die 'Invalid package memory requirement in manifest'
                case "$f4:$f5" in
                    apk:*.apk|ipk:*.ipk) ;;
                    *) die 'Package format and filename disagree in manifest' ;;
                esac
                SUPPORTED_SYSTEMS=$(append_line "$SUPPORTED_SYSTEMS" "  ${f1} | ${f2} | ${f3} | ${f4}")
                if [ "$f1" = "$OPENWRT_RELEASE" ] && \
                    [ "$f2" = "$OPENWRT_TARGET" ] && \
                    [ "$f3" = "$OPENWRT_ARCH" ]; then
                    PACKAGE_MATCHES=$((PACKAGE_MATCHES + 1))
                    PACKAGE_FORMAT="$f4"
                    PACKAGE_ASSET="$f5"
                    PACKAGE_SHA256="$f6"
                    PACKAGE_MIN_OVERLAY_KIB="$f7"
                    PACKAGE_MIN_TMP_KIB="$f8"
                    PACKAGE_MIN_MEMORY_KIB="$f9"
                    PACKAGE_FIREWALL="$f10"
                    PACKAGE_VALIDATION="$f11"
                    PACKAGE_TESTED_BOARDS="$f12"
                fi
                ;;
            core)
                [ -z "$f6$f7$f8$f9$f10$f11$f12$f13$extra" ] || die 'Malformed core record in manifest'
                case "$f2" in
                    v[0-9]*) ;;
                    *) die 'Invalid Mihomo release version in manifest' ;;
                esac
                case "$f2" in
                    *[!A-Za-z0-9._-]*) die 'Unsafe Mihomo release version in manifest' ;;
                esac
                is_safe_asset_name "$f3" || die 'Unsafe Mihomo asset name in manifest'
                is_sha256 "$f4" || die 'Invalid Mihomo SHA-256 in manifest'
                is_uint "$f5" || die 'Invalid Mihomo compressed size in manifest'
                if [ "$f1" = "$MIHOMO_ARCH" ]; then
                    CORE_MATCHES=$((CORE_MATCHES + 1))
                    MIHOMO_VERSION="$f2"
                    MIHOMO_ASSET="$f3"
                    MIHOMO_SHA256="$f4"
                    MIHOMO_COMPRESSED_BYTES="$f5"
                fi
                ;;
            *)
                die "Unknown manifest record: $record"
                ;;
        esac
    done < "$MANIFEST_FILE"

    [ "$MANIFEST_VERSION" = '1' ] || die "Unsupported manifest schema: ${MANIFEST_VERSION:-missing}"
    [ "$MANIFEST_CHANNEL" = "$CHANNEL" ] || die "Manifest channel ${MANIFEST_CHANNEL} does not match ${CHANNEL}"
    printf '%s\n' "$MANIFEST_TAG" |
        grep -Eq '^v[0-9]+(\.[0-9]+)*-party\.[0-9]+$' ||
        die "Invalid PARTY release tag in manifest: $MANIFEST_TAG"
    [ "v${MANIFEST_PARTY_VERSION}" = "$MANIFEST_TAG" ] || die 'Manifest tag and PARTY version disagree'

    if [ "$PACKAGE_MATCHES" -eq 0 ]; then
        printf '\nSupported systems in this manifest:\n%s\n' "$SUPPORTED_SYSTEMS" >&2
        die 'No verified PARTY package exactly matches this OpenWrt system'
    fi
    [ "$PACKAGE_MATCHES" -eq 1 ] || die 'The manifest contains duplicate matching packages'

    [ "$CORE_MATCHES" -eq 1 ] || die "The manifest must contain one Mihomo core for ${MIHOMO_ARCH}"

    case "$PACKAGE_FORMAT:$PACKAGE_MANAGER" in
        apk:apk|ipk:opkg) ;;
        *) die "The matching ${PACKAGE_FORMAT} package cannot be installed with ${PACKAGE_MANAGER}" ;;
    esac
    [ "$PACKAGE_FIREWALL" = "$FIREWALL_BACKEND" ] || die "The package requires ${PACKAGE_FIREWALL}, detected ${FIREWALL_BACKEND}"
    validate_manager_architecture

    PACKAGE_URL="${PARTY_REPOSITORY_URL}/releases/download/${MANIFEST_TAG}/${PACKAGE_ASSET}"
    PACKAGE_SIDECAR_URL="${PACKAGE_URL}.sha256"
    MIHOMO_URL="${MIHOMO_REPOSITORY_URL}/releases/download/${MIHOMO_VERSION}/${MIHOMO_ASSET}"
}

find_conflicts() {
    CONFLICTS=''
    for conflict_package in \
        luci-app-openclash openclash \
        luci-app-clashoo clashoo \
        luci-app-fchomo fchomo \
        luci-app-nikki nikki \
        luci-app-podkop podkop \
        luci-app-homeproxy homeproxy \
        luci-app-passwall luci-app-passwall2 \
        luci-app-daed dae \
        luci-app-ssr-plus luci-app-vssr luci-app-bypass \
        sing-box; do
        if package_is_installed "$conflict_package"; then
            CONFLICTS=$(append_line "$CONFLICTS" "$conflict_package")
        fi
    done
}

board_is_live_tested() {
    [ -n "$PACKAGE_TESTED_BOARDS" ] || return 1
    old_ifs=$IFS
    IFS=';'
    for tested_board in $PACKAGE_TESTED_BOARDS; do
        if [ "$tested_board" = "$BOARD_NAME" ]; then
            IFS=$old_ifs
            return 0
        fi
    done
    IFS=$old_ifs
    return 1
}

calculate_plan() {
    HAS_SSCLASH=0
    package_is_installed luci-app-ssclash && HAS_SSCLASH=1

    PACKAGE_NEEDED=1
    RELEASE_STATUS=update-available
    if [ -n "$CURRENT_PARTY_VERSION" ]; then
        is_party_version "$CURRENT_PARTY_VERSION" ||
            die 'The installed PARTY version marker is invalid'
        version_comparison=$(party_version_compare "$CURRENT_PARTY_VERSION" "$MANIFEST_PARTY_VERSION")
        if [ "$version_comparison" -eq 0 ] && [ "$MERGER_PRESENT" -eq 1 ]; then
            PACKAGE_NEEDED=0
            RELEASE_STATUS=up-to-date
        elif [ "$version_comparison" -gt 0 ]; then
            PACKAGE_NEEDED=0
            RELEASE_STATUS=installed-newer
        fi
    fi

    CORE_NEEDED=0
    if [ "$NO_CORE" -eq 0 ] && [ "$CORE_PRESENT" -eq 0 ]; then
        CORE_NEEDED=1
    fi

    PACKAGE_MIGRATION=0
    if [ "$HAS_SSCLASH" -eq 1 ] && [ -z "$CURRENT_PARTY_VERSION" ] && [ "$PACKAGE_NEEDED" -eq 1 ]; then
        PACKAGE_MIGRATION=1
    fi

    if [ "$COMMAND" = 'upgrade' ] && [ -z "$CURRENT_PARTY_VERSION" ]; then
        die 'The upgrade command requires an existing PARTY installation; use install instead'
    fi

    if [ "$CORE_NEEDED" -eq 1 ]; then
        REQUIRED_OVERLAY_KIB=$PACKAGE_MIN_OVERLAY_KIB
        REQUIRED_TMP_KIB=$PACKAGE_MIN_TMP_KIB
    elif [ "$PACKAGE_NEEDED" -eq 1 ]; then
        REQUIRED_OVERLAY_KIB=16384
        REQUIRED_TMP_KIB=8192
    else
        REQUIRED_OVERLAY_KIB=0
        REQUIRED_TMP_KIB=1024
    fi

    [ "$MEMORY_KIB" -ge "$PACKAGE_MIN_MEMORY_KIB" ] || die "At least ${PACKAGE_MIN_MEMORY_KIB} KiB RAM is required"
    [ "$OVERLAY_FREE_KIB" -ge "$REQUIRED_OVERLAY_KIB" ] || die "At least ${REQUIRED_OVERLAY_KIB} KiB free overlay space is required for this plan"
    [ "$TMP_FREE_KIB" -ge "$REQUIRED_TMP_KIB" ] || die "At least ${REQUIRED_TMP_KIB} KiB free temporary space is required for this plan"

    find_conflicts
    if [ -n "$CONFLICTS" ]; then
        printf '\nConflicting proxy packages were detected:\n%s\n' "$CONFLICTS" >&2
        die 'Remove or deliberately migrate conflicting proxy software before installing PARTY'
    fi
}

print_installation_plan() {
    separator
    info "Manifest:       ${MANIFEST_SOURCE}"
    info "PARTY release:  ${MANIFEST_TAG}"
    info "Update status:  ${RELEASE_STATUS}"
    info "Package:        ${PACKAGE_ASSET}"
    info "Validation:     ${PACKAGE_VALIDATION}"
    if board_is_live_tested; then
        info 'Device support: live-tested board'
    else
        info 'Device support: exact CI-built target/architecture match'
    fi
    info "Mihomo target:  ${MIHOMO_ASSET}"
    if [ "$PACKAGE_NEEDED" -eq 1 ]; then
        info 'Package action: install or update PARTY'
    elif [ "$RELEASE_STATUS" = 'installed-newer' ]; then
        info 'Package action: keep the newer installed PARTY version'
    else
        info 'Package action: already at the selected PARTY release'
    fi
    if [ "$NO_CORE" -eq 1 ]; then
        info 'Mihomo action:  skipped by request'
    elif [ "$CORE_NEEDED" -eq 1 ]; then
        info "Mihomo action:  install pinned ${MIHOMO_VERSION} core"
    else
        info 'Mihomo action:  keep the existing valid core'
    fi
    info 'Firmware action: no firmware image will be downloaded or flashed'
    separator
}

run_doctor() {
    detect_system
    print_system_summary
    discover_manifest

    parse_manifest
    calculate_plan
    print_installation_plan
    log 'Doctor result: supported and safe to continue.'
}

run_update_check() {
    run_doctor
    printf 'SSCLASH_PARTY_UPDATE|%s|%s|%s\n' \
        "${CURRENT_PARTY_VERSION:-none}" \
        "$MANIFEST_PARTY_VERSION" \
        "$RELEASE_STATUS"
}

confirm_installation() {
    if [ "$PACKAGE_MIGRATION" -eq 1 ]; then
        warn 'An existing non-PARTY package will be replaced in place.'
        if [ "$ASSUME_YES" -eq 1 ] && [ "$ALLOW_PACKAGE_MIGRATION" -ne 1 ]; then
            die 'Unattended package migration requires --allow-package-migration'
        fi
        if [ "$ASSUME_YES" -ne 1 ]; then
            [ -t 0 ] || die 'Interactive confirmation is unavailable; rerun with explicit migration flags'
            printf 'Replace the existing package with PARTY? [y/N] '
            read -r answer
            case "$answer" in y|Y|yes|YES) ;; *) die 'Installation cancelled' ;; esac
        fi
    fi

    if [ "$ASSUME_YES" -eq 1 ]; then
        return 0
    fi
    [ -t 0 ] || die 'Interactive confirmation is unavailable; rerun with --yes'
    printf 'Proceed with this installation plan? [y/N] '
    read -r answer
    case "$answer" in y|Y|yes|YES) ;; *) die 'Installation cancelled' ;; esac
}

prepare_payloads() {
    if [ "$PACKAGE_NEEDED" -eq 1 ]; then
        PACKAGE_FILE="$WORK_DIR/$PACKAGE_ASSET"
        PACKAGE_SIDECAR_FILE="${PACKAGE_FILE}.sha256"
        log 'Downloading the exact PARTY package and checksum...'
        download_required "$PACKAGE_URL" "$PACKAGE_FILE"
        download_required "$PACKAGE_SIDECAR_URL" "$PACKAGE_SIDECAR_FILE"
        verify_sidecar "$PACKAGE_FILE" "$PACKAGE_SIDECAR_FILE" "$PACKAGE_ASSET"
        [ "$VERIFIED_SHA256" = "$PACKAGE_SHA256" ] || die 'Package checksum differs from the release manifest'
    fi

    if [ "$CORE_NEEDED" -eq 1 ]; then
        MIHOMO_FILE="$WORK_DIR/$MIHOMO_ASSET"
        log "Downloading pinned Mihomo ${MIHOMO_VERSION}..."
        download_required "$MIHOMO_URL" "$MIHOMO_FILE"
        actual_core_hash=$(sha256_file "$MIHOMO_FILE")
        [ "$actual_core_hash" = "$MIHOMO_SHA256" ] || die 'Mihomo checksum differs from the release manifest'
        actual_core_size=$(file_size_bytes "$MIHOMO_FILE")
        [ "$actual_core_size" = "$MIHOMO_COMPRESSED_BYTES" ] || die 'Mihomo size differs from the release manifest'
        gzip -t "$MIHOMO_FILE" >/dev/null 2>&1 || die 'The downloaded Mihomo archive is invalid'
    fi
}

capture_service_state() {
    state_file="$1"
    {
        printf 'clash_enabled=%s\n' "$CLASH_ENABLED_BEFORE"
        printf 'clash_running=%s\n' "$CLASH_RUNNING_BEFORE"
        printf 'party_version=%s\n' "${CURRENT_PARTY_VERSION:-none}"
    } > "$state_file"
}

copy_recovery_path() {
    relative_path="$1"
    source_path=$(root_path "/$relative_path")
    destination_path="$2/$relative_path"
    [ -e "$source_path" ] || return 0
    mkdir -p "$(dirname "$destination_path")"
    cp -pR "$source_path" "$destination_path"
}

create_recovery_archive() {
    recovery_needed=0
    [ "$HAS_SSCLASH" -eq 1 ] && recovery_needed=1
    [ -n "$CURRENT_PARTY_VERSION" ] && recovery_needed=1
    for recovery_candidate in \
        /etc/config/ssclash_profile \
        /etc/ssclash-party \
        /opt/clash/config.yaml; do
        [ -e "$(root_path "$recovery_candidate")" ] && recovery_needed=1
    done
    if [ "$recovery_needed" -eq 0 ]; then
        return 0
    fi

    recovery_stage="$WORK_DIR/recovery"
    mkdir -p "$recovery_stage/state"
    copy_recovery_path etc/config/ssclash_profile "$recovery_stage"
    copy_recovery_path etc/ssclash-party "$recovery_stage"
    copy_recovery_path opt/clash/config.yaml "$recovery_stage"
    capture_service_state "$recovery_stage/state/installer-state.txt"

    timestamp=$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%s)
    RECOVERY_ARCHIVE="/tmp/ssclash-party-recovery-${timestamp}-$$.tar.gz"
    tar -czf "$RECOVERY_ARCHIVE" -C "$recovery_stage" . || die 'Could not create the recovery archive'
    chmod 600 "$RECOVERY_ARCHIVE"
    recovery_hash=$(sha256_file "$RECOVERY_ARCHIVE")
    printf '%s  %s\n' "$recovery_hash" "$(basename "$RECOVERY_ARCHIVE")" > "${RECOVERY_ARCHIVE}.sha256"
    chmod 600 "${RECOVERY_ARCHIVE}.sha256"
    log "Recovery archive created: ${RECOVERY_ARCHIVE}"
}

install_package() {
    [ "$PACKAGE_NEEDED" -eq 1 ] || return 0
    MUTATION_STARTED=1

    if [ "$PACKAGE_MANAGER" = 'apk' ]; then
        log 'Updating the apk package index...'
        apk update || die 'apk update failed'
        log 'Simulating the PARTY package transaction...'
        apk add --simulate --allow-untrusted --force-reinstall "$PACKAGE_FILE" ||
            die 'apk rejected the simulated package transaction'
        log 'Installing the PARTY package...'
        apk add --allow-untrusted --force-reinstall "$PACKAGE_FILE" ||
            die 'apk failed to install PARTY'
    else
        log 'Updating the opkg package index...'
        opkg update || die 'opkg update failed'
        if opkg --help 2>&1 | grep -q -e '--noaction'; then
            log 'Simulating the PARTY package transaction...'
            opkg --noaction install --force-reinstall "$PACKAGE_FILE" ||
                die 'opkg rejected the simulated package transaction'
        fi
        log 'Installing the PARTY package...'
        opkg install --force-reinstall "$PACKAGE_FILE" || die 'opkg failed to install PARTY'
    fi
}

install_core() {
    [ "$CORE_NEEDED" -eq 1 ] || return 0
    MUTATION_STARTED=1

    clash_home=$(root_path /opt/clash)
    clash_directory="$clash_home/bin"
    clash_binary="$clash_directory/clash"
    candidate="$clash_directory/.clash.party-new.$$"
    previous="$clash_directory/.clash.pre-party.$$"
    config_file="$clash_home/config.yaml"
    mkdir -p "$clash_directory"

    gzip -dc "$MIHOMO_FILE" > "$candidate" || {
        rm -f "$candidate"
        die 'Could not unpack Mihomo'
    }
    chmod 755 "$candidate"
    "$candidate" -v >/dev/null 2>&1 || {
        rm -f "$candidate"
        die 'The unpacked Mihomo binary cannot run on this device'
    }
    if [ -s "$config_file" ]; then
        "$candidate" -t -d "$clash_home" -f "$config_file" >/dev/null 2>&1 || {
            rm -f "$candidate"
            die 'The pinned Mihomo core rejected the existing configuration'
        }
    fi

    if [ -e "$clash_binary" ]; then
        mv "$clash_binary" "$previous" || {
            rm -f "$candidate"
            die 'Could not preserve the previous Mihomo binary'
        }
    fi
    if ! mv "$candidate" "$clash_binary"; then
        [ -e "$previous" ] && mv "$previous" "$clash_binary"
        die 'Could not activate the Mihomo binary'
    fi
    chmod 755 "$clash_binary"
    [ -e "$previous" ] && warn "Previous invalid core retained at ${previous}"
    log "Installed pinned Mihomo ${MIHOMO_VERSION}."
}

restore_service_contract() {
    [ "$TESTING" = '1' ] && return 0
    clash_init=$(root_path /etc/init.d/clash)
    sync_init=$(root_path /etc/init.d/ssclash-profile-sync)
    [ -x "$clash_init" ] || die 'PARTY did not install the Clash init script'

    if [ "$HAS_SSCLASH" -eq 0 ]; then
        "$clash_init" stop >/dev/null 2>&1 || true
        "$clash_init" disable >/dev/null 2>&1 || true
        if [ -x "$sync_init" ]; then
            "$sync_init" stop >/dev/null 2>&1 || true
            "$sync_init" disable >/dev/null 2>&1 || true
        fi
        return 0
    fi

    if [ "$CLASH_ENABLED_BEFORE" -eq 1 ]; then
        "$clash_init" enable >/dev/null 2>&1 || die 'Could not restore Clash boot enablement'
    else
        "$clash_init" disable >/dev/null 2>&1 || die 'Could not preserve disabled Clash boot state'
    fi
    if [ "$CLASH_RUNNING_BEFORE" -eq 1 ]; then
        "$clash_init" start >/dev/null 2>&1 || die 'Could not restore the running Clash service'
    else
        "$clash_init" stop >/dev/null 2>&1 || true
    fi
}

postflight_check() {
    installed_version_file=$(root_path /usr/share/ssclash-party/VERSION)
    installed_merger=$(root_path /usr/bin/ssclash-profile-merge)
    clash_binary=$(root_path /opt/clash/bin/clash)
    clash_home=$(root_path /opt/clash)
    config_file="$clash_home/config.yaml"

    [ -r "$installed_version_file" ] || die 'The PARTY version marker is missing after installation'
    installed_version=$(sed -n '1p' "$installed_version_file")
    expected_version="$MANIFEST_PARTY_VERSION"
    [ "$PACKAGE_NEEDED" -eq 1 ] || expected_version="$CURRENT_PARTY_VERSION"
    [ "$installed_version" = "$expected_version" ] || die "Installed PARTY version ${installed_version} does not match ${expected_version}"
    [ -x "$installed_merger" ] || die 'The PARTY profile merger is missing after installation'

    if [ "$NO_CORE" -eq 0 ]; then
        [ -x "$clash_binary" ] || die 'Mihomo is missing after installation'
        "$clash_binary" -v >/dev/null 2>&1 || die 'Mihomo cannot run after installation'
        if [ -s "$config_file" ]; then
            "$clash_binary" -t -d "$clash_home" -f "$config_file" >/dev/null 2>&1 || die 'Mihomo rejected the installed configuration'
        fi
    fi

    if [ "$TESTING" != '1' ] && [ "$HAS_SSCLASH" -eq 0 ]; then
        clash_init=$(root_path /etc/init.d/clash)
        if "$clash_init" enabled >/dev/null 2>&1 || "$clash_init" status >/dev/null 2>&1; then
            die 'A first installation unexpectedly left Clash enabled or running'
        fi
    fi
}

run_install() {
    run_doctor

    if [ "$PACKAGE_NEEDED" -eq 0 ] && { [ "$CORE_NEEDED" -eq 0 ] || [ "$NO_CORE" -eq 1 ]; }; then
        if [ "$RELEASE_STATUS" = 'installed-newer' ]; then
            log 'The installed PARTY version is newer than this channel; no downgrade was performed.'
        else
            log 'The selected PARTY release is already installed; no changes are required.'
        fi
        return 0
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        log 'Dry run complete; no changes were made.'
        return 0
    fi

    confirm_installation
    prepare_payloads
    create_recovery_archive
    install_package
    install_core
    restore_service_contract
    postflight_check

    separator
    log 'SSClash PARTY installation completed successfully.'
    if [ -n "$RECOVERY_ARCHIVE" ]; then
        info "Recovery material: ${RECOVERY_ARCHIVE}"
    fi
    if [ "$HAS_SSCLASH" -eq 0 ]; then
        info 'Clash remains stopped and disabled until you configure PARTY.'
    fi
    info 'Open LuCI -> Services -> SSClash to choose a configuration source.'
    separator
}

parse_arguments "$@"

if [ "$TESTING" != '1' ] && [ "$COMMAND" != 'doctor' ] && [ "$COMMAND" != 'check' ] && [ "$(id -u)" -ne 0 ]; then
    die 'Installation must be run as root on the OpenWrt router'
fi

case "$COMMAND" in
    doctor) run_doctor ;;
    check) run_update_check ;;
    install|upgrade) run_install ;;
esac
