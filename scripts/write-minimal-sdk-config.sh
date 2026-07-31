#!/usr/bin/env bash

set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: write-minimal-sdk-config.sh SDK_DIR [TARGET_DEVICE_SYMBOL]

Create a minimal OpenWrt SDK .config for building luci-app-ssclash.
Run `make defconfig` once before this script so tmp/.packageinfo exists.

TARGET_DEVICE_SYMBOL is optional. When supplied, it must be the complete
Kconfig symbol, for example:
TARGET_DEVICE_mediatek_filogic_DEVICE_cudy_wbr3000uax-v1
EOF
	exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage

sdk_dir="${1%/}"
target_device_symbol="${2:-}"
config_build="${sdk_dir}/Config-build.in"
package_info="${sdk_dir}/tmp/.packageinfo"
output="${sdk_dir}/.config"

[ -f "$config_build" ] || {
	printf 'Missing SDK build configuration: %s\n' "$config_build" >&2
	exit 1
}

[ -f "$package_info" ] || {
	printf 'Missing SDK package metadata: %s\n' "$package_info" >&2
	printf 'Run make defconfig in the SDK before this script.\n' >&2
	exit 1
}

if [ -n "$target_device_symbol" ]; then
	case "$target_device_symbol" in
		TARGET_DEVICE_*)
			;;
		*)
			printf 'Invalid target device symbol: %s\n' "$target_device_symbol" >&2
			exit 1
			;;
	esac

	if ! grep -Fqx "config ${target_device_symbol}" "$config_build"; then
		printf 'Target device symbol is not present in this SDK: %s\n' \
			"$target_device_symbol" >&2
		exit 1
	fi
fi

build_temporary="$(mktemp "${sdk_dir}/Config-build.in.ssclash.XXXXXX")"
config_temporary="$(mktemp "${sdk_dir}/.config.ssclash.XXXXXX")"
trap 'rm -f "$build_temporary" "$config_temporary"' EXIT

# Config-build.in symbols do not necessarily have a prompt, so a normal
# "# CONFIG_PACKAGE_x is not set" seed cannot override their buildbot
# defaults. Remove the package and LuCI-language snapshot blocks so their real
# Kconfig definitions supply defaults. Neutralize package default markers and
# multi-device build symbols in the temporary SDK itself.
awk -v selected="$target_device_symbol" '
	NR == FNR {
		if ($1 == "Package:") {
			default_symbol["DEFAULT_" $2] = 1
		}
		next
	}

	$1 == "config" {
		current = $2
		skip = current ~ /^PACKAGE_/ ||
			current ~ /^LUCI_LANG_/ ||
			current ~ /^MODULE_DEFAULT_/
		rewrite = (current in default_symbol)
		rewrite = rewrite ||
			current == "BUILDBOT" ||
			current == "TARGET_MULTI_PROFILE" ||
			current == "TARGET_ALL_PROFILES" ||
			current == "TARGET_PER_DEVICE_ROOTFS"
		rewrite = rewrite ||
			(current ~ /^TARGET_DEVICE_/ &&
			 current !~ /^TARGET_DEVICE_PACKAGES_/ &&
			 current != selected)
	}

	skip {
		next
	}

	rewrite && $1 == "default" && NF == 2 &&
		($2 == "m" || $2 == "y") {
		sub(/default [my]$/, "default n")
	}

	{ print }
' "$package_info" "$config_build" > "$build_temporary"

mv "$build_temporary" "$config_build"

{
	printf '%s\n' \
		'# CONFIG_ALL is not set' \
		'# CONFIG_ALL_KMODS is not set' \
		'# CONFIG_ALL_NONSHARED is not set' \
		'# CONFIG_BUILDBOT is not set' \
		'# CONFIG_TARGET_MULTI_PROFILE is not set' \
		'# CONFIG_TARGET_ALL_PROFILES is not set' \
		'# CONFIG_TARGET_PER_DEVICE_ROOTFS is not set'

	if [ -n "$target_device_symbol" ]; then
		awk -v selected="$target_device_symbol" '
			$1 == "config" &&
			$2 ~ /^TARGET_DEVICE_/ &&
			$2 !~ /^TARGET_DEVICE_PACKAGES_/ {
				if ($2 == selected) {
					print "CONFIG_" $2 "=y"
				} else {
					print "# CONFIG_" $2 " is not set"
				}
			}
		' "$config_build"
	fi

	printf '%s\n' \
		'CONFIG_PACKAGE_luci-app-ssclash=m' \
		'CONFIG_PACKAGE_luci-app-ssclash_Nftables_Transparent_Proxy=y'
} > "$config_temporary"

mv "$config_temporary" "$output"
trap - EXIT
