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
grep -Fq 'ssclash_profile.main.user_agent=auto' "$temporary/postinst"
printf 'package maintainer scripts passed syntax checks\n'
