#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
makefile="$repo_root/luci-app-ssclash/Makefile"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

for script_name in preinst postinst prerm postrm; do
    output="$temporary/$script_name"
    awk -v wanted="define Package/\$(PKG_NAME)/$script_name" '
        $0 == wanted {
            copying = 1
            next
        }
        copying && $0 == "endef" {
            exit
        }
        copying {
            print
        }
    ' "$makefile" | sed 's/\$\$/\$/g' > "$output"
    [[ -s "$output" ]]
    sh -n "$output"
done

grep -Fq "\${PKG_UPGRADE:-0}" "$temporary/prerm"
grep -Fq "\${PKG_UPGRADE:-0}" "$temporary/postrm"
grep -Fq "\${PKG_UPGRADE:-0}" "$temporary/postinst"
grep -Fq "echo \"HAD_CONFIG=\$HAD_CONFIG\"" "$temporary/preinst"
grep -Fq "echo \"PREVIOUS_PARTY_VERSION=\$PREVIOUS_PARTY_VERSION\"" "$temporary/preinst"
grep -Fq '4.7.0-party.9)' "$temporary/preinst"
grep -Fq "grep -qx 'HAD_CONFIG=1'" "$temporary/postinst"
grep -Fq '/usr/libexec/ssclash-party-migrate' "$temporary/postinst"
grep -Fq '/usr/libexec/ssclash-party-panel apply' "$temporary/postinst"
grep -Fq 'ssclash_profile.main.active_profile' "$temporary/postinst"
grep -Fq 'CLASH_SHOULD_RUN=1' "$temporary/postinst"
grep -Fq 'LEGACY_LIFECYCLE_RECOVERY=1' "$temporary/postinst"
grep -Fq '/etc/init.d/ssclash-profile-sync start' "$temporary/postinst"
grep -Fq 'rm -f /etc/config/ssclash_profile.apk-new' "$temporary/postinst"
grep -Fq '/usr/libexec/ssclash-party-panel remove' "$temporary/prerm"
if grep -Fq "grep -qx 'SYNC_RUNNING=1'" "$temporary/postinst"; then
    printf 'postinst must not trust runtime state observed after APK service stop\n' >&2
    exit 1
fi
printf 'package maintainer scripts passed syntax checks\n'
