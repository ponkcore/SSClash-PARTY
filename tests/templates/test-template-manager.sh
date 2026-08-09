#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/luci-app-ssclash/rootfs/usr/libexec/ssclash-template-manager"
builtin_dir="$repo_root/luci-app-ssclash/rootfs/usr/share/ssclash-party/templates"
temporary_root="$(mktemp -d)"
input="$(mktemp /tmp/ssclash-party-template.test.XXXXXX.yaml)"
trap 'rm -rf "$temporary_root"; rm -f "$input"' EXIT

merger="$temporary_root/ssclash-profile-merge"
(
    cd "$repo_root/luci-app-ssclash/profile-merge"
    go build -mod=vendor -o "$merger" .
)

mihomo="$temporary_root/mihomo"
cat > "$mihomo" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod +x "$mihomo"

custom_dir="$temporary_root/custom"
legacy_dir="$temporary_root/legacy"
mkdir -p "$custom_dir" "$legacy_dir"
printf '%s\n' 'example.com' 'example.net' > "$legacy_dir/old.txt"

cat > "$input" <<'EOF'
mixed-port: 7890
secret: do-not-keep
proxies:
  - name: private-node
    type: ss
    server: private.invalid
    password: private
dns:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - https://1.1.1.1/dns-query
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - private-node
rules:
  - MATCH,PROXY
EOF

run_helper() {
    SSCLASH_TEMPLATE_MERGER="$merger" \
    SSCLASH_TEMPLATE_BUILTIN_DIR="$builtin_dir" \
    SSCLASH_TEMPLATE_CUSTOM_DIR="$custom_dir" \
    SSCLASH_TEMPLATE_LEGACY_DIR="$legacy_dir" \
    SSCLASH_TEMPLATE_MIHOMO="$mihomo" \
        "$helper" "$@"
}

prepared="$(run_helper prepare "$input")"
jq -e '
    .ok == true and
    .document.proxies == null and
    .document.secret == null and
    .document.dns["enhanced-mode"] == null and
    .document["proxy-groups"][0]["include-all"] == true and
    (.report.removed | length) >= 4
' <<< "$prepared" >/dev/null

printf '%s\n' "$prepared" | jq -r .yaml > "$input"
saved="$(run_helper save custom 0 'Custom template' 'Integration test' "$input")"
jq -e '.id == "custom" and .revision == 1 and .source == "custom"' <<< "$saved" >/dev/null
[[ "$(stat -c '%a' "$custom_dir/custom/template.yaml")" == 600 ]]
[[ "$(stat -c '%a' "$custom_dir/custom")" == 700 ]]

catalog="$(run_helper list)"
jq -e '
    any(.templates[]; .id == "russia" and .read_only == true) and
    any(.templates[]; .id == "custom" and .revision == 1) and
    any(.legacy_lists[]; .name == "old.txt" and .entries == 2)
' <<< "$catalog" >/dev/null

run_helper save custom 1 'Custom template' 'Second revision' "$input" >/dev/null
record="$(run_helper get custom)"
jq -e '.revision == 2 and .history == [1]' <<< "$record" >/dev/null

run_helper restore custom 1 2 >/dev/null
run_helper delete custom 3 >/dev/null
[[ ! -e "$custom_dir/custom" ]]
[[ "$(find "$custom_dir/.trash" -mindepth 1 -maxdepth 1 -type d | wc -l)" == 1 ]]

printf 'template-manager integration tests passed\n'
