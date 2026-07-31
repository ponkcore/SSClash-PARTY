<p align="right">
  <strong>English</strong> · <a href="README.ru.md">Русский</a>
</p>

<h1 align="center">SSClash PARTY</h1>

<h3 align="center">Mihomo for OpenWrt, made easy — and applied safely</h3>

<p align="center">
  <a href="https://github.com/ponkcore/SSClash-PARTY/actions/workflows/build.yml?query=branch%3Aparty"><img alt="Build and test" src="https://github.com/ponkcore/SSClash-PARTY/actions/workflows/build.yml/badge.svg?branch=party"></a>
  <img alt="Status: Public Preview" src="https://img.shields.io/badge/status-public_preview-orange">
  <a href="LICENSE"><img alt="License: GPL-2.0" src="https://img.shields.io/badge/license-GPL--2.0-blue.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/ponkcore/SSClash-PARTY/releases">Download the public preview</a>
  · <a href="#quick-start">Quick start</a>
  · <a href="#documentation">Documentation</a>
</p>

SSClash PARTY is a LuCI application for OpenWrt that turns an adaptive
subscription, a list of proxy share links, or manually maintained YAML into a
validated Mihomo configuration. It applies managed configurations with health
checks and automatic rollback while keeping router-critical integration under
local control.

> [!IMPORTANT]
> PARTY is currently a public preview. Install only a package that exactly
> matches your OpenWrt release, target, and package architecture, and keep a
> current router backup.

## Why PARTY

Proxy providers do not all return the same kind of subscription. One URL may
produce a complete Mihomo policy, a nodes-only YAML document, plaintext share
links, or a Base64-encoded URI list depending on its client detection. A valid
remote profile may also contain settings that are unsafe to adopt blindly on a
router.

PARTY handles that boundary in LuCI:

- it discovers and classifies the source instead of assuming one response
  format;
- it can retain a complete provider policy or combine imported proxies with a
  trusted local template;
- it protects the controller, DNS, TProxy, routing, and provider-cache
  settings that belong to the router;
- it validates the exact candidate with the installed Mihomo core before
  activation;
- it keeps the last-known-good profile when a download, validation, reload, or
  health check fails.

## Choose your configuration source

Open **Services → SSClash → Configuration** and choose one of three mutually
exclusive sources.

| Source | What you provide | Routing policy | Scheduled updates |
|---|---|---|---|
| **Subscription** | One HTTPS subscription URL | Keep a complete remote policy automatically, or always apply the selected PARTY template | Yes |
| **Proxy links** | A newline-separated list of Mihomo-compatible share links | Selected PARTY template | Not needed; the source is local |
| **Manual YAML** | A complete Mihomo configuration | Fully controlled by the user | No |

### Adaptive subscription

PARTY requests the subscription with the installed Mihomo identity and a
neutral PARTY fallback. It starts without an HWID and adds stable
Remnawave-compatible device headers only if the server explicitly requires
them.

Supported responses are classified as:

- complete Mihomo YAML with proxies, groups, rule providers, and ordered
  rules;
- nodes-only Mihomo YAML;
- plaintext proxy URIs;
- an outer Base64-encoded URI list.

In **Automatic** policy mode, a complete remote policy stays provider-managed,
so later group and rule changes can arrive with the subscription. Nodes-only
and URI responses use the selected PARTY template. Select **Always use the
selected PARTY template** to import only proxies even when the provider sends
a complete policy.

### Proxy share links

Paste individual rows or a newline-separated list of VLESS, VMess,
Shadowsocks, Trojan, Hysteria/Hysteria2, TUIC, or other URI formats understood
by the installed Mihomo core. PARTY normalizes and deduplicates the list, then
attaches it to the selected routing template. Input is bounded by safety size
limits, but there is no fixed UI row count.

### Manual YAML

Use the built-in YAML editor when you want the original fully manual workflow.
The editor is authoritative in this mode; PARTY does not regenerate the file
or schedule subscription updates.

## Safe by construction

Every managed apply follows the same transaction:

<p align="center">
  <strong>Fetch or read</strong> → <strong>Classify</strong> → <strong>Merge protected settings</strong> → <strong>Test with Mihomo</strong> → <strong>Apply and health-check</strong>
</p>

PARTY acquires an operation lock, builds the candidate, applies its local
safety overlay, and runs Mihomo's native configuration test. A changed profile
is installed atomically. Policy-only changes use an authenticated hot reload;
protected runtime changes use a guarded restart. Controller, router DNS, and a
real proxy path are checked after activation. If any step fails, PARTY restores
the previous profile.

The scheduled updater runs only in Subscription mode. It never starts a Clash
service that the operator deliberately stopped.

## What PARTY includes

| Capability | What it means |
|---|---|
| Adaptive source discovery | Complete YAML, nodes-only YAML, plaintext URIs, and Base64 URI lists can use the same subscription field |
| Optional provider policy | Preserve provider-managed groups and rules, or force a trusted PARTY template |
| Guarded activation | Mihomo validation, atomic replacement, post-apply health checks, and rollback |
| Router-owned safety overlay | Authenticated controller, local dashboard, DNS policy, TProxy integration, routing-loop prevention, and confined provider caches stay protected |
| Remnawave compatibility | Client negotiation and optional stable HWID headers without creating new identities on device-limit errors |
| LuCI workflow | Source selection, status, logs, local rulesets, service control, Mihomo management, and authenticated Zashboard access |
| Template catalog | The initial **Russia** policy template contains public rule providers and no proxy credentials or router secrets |

## Supported packages

The current public preview,
[`v4.7.0-party.3`](https://github.com/ponkcore/SSClash-PARTY/releases/tag/v4.7.0-party.3),
publishes the following architecture-specific packages:

| OpenWrt release | Target | Package architecture | Format | Validation level |
|---|---|---|---|---|
| 25.12.5 | `mediatek/filogic` | `aarch64_cortex-a53` | APK | CI-built and live-tested on Cudy WBR3000UAX v1 |
| 25.12.5 | `x86/64` | `x86_64` | APK | CI-built and package-inspected |
| 24.10.8 | `x86/64` | `x86_64` | IPK | CI-built and package-inspected |

An “ARM64” or “x86-64” CPU description alone is not enough. Match the exact
OpenWrt release line, target, subtarget, `DISTRIB_ARCH`, and package format.
This table describes PARTY packages, not firmware images; PARTY never flashes
your router.

## Quick start

### Automatic installation — recommended

Connect to the OpenWrt router over SSH as `root` and paste this single command:

```sh
wget -qO /tmp/ssclash-party-install.sh https://raw.githubusercontent.com/ponkcore/SSClash-PARTY/party/install-ssclash.sh && sh /tmp/ssclash-party-install.sh install
```

The `&&` boundary downloads the complete installer before execution. PARTY
does not support piping a live network response directly into `sh`.

The installer runs its read-only doctor first, selects only an exact published
OpenWrt release/target/architecture match, detects proxy conflicts, checks
resources and the native package manager, and verifies every package checksum.
It installs the pinned Mihomo core only when a valid core is missing. It never
flashes firmware or removes another proxy stack.

On a first installation, Clash remains stopped and disabled until you add a
configuration. Existing PARTY upgrades preserve the active profile and the
previous running and boot-enabled state.

Run only the compatibility report without installing anything:

```sh
wget -qO /tmp/ssclash-party-install.sh https://raw.githubusercontent.com/ponkcore/SSClash-PARTY/party/install-ssclash.sh && sh /tmp/ssclash-party-install.sh doctor
```

> [!IMPORTANT]
> Automatic means exact matching, not guessing. An unsupported firmware,
> target, architecture, firewall, resource level, or conflicting proxy package
> causes a safe stop before persistent changes.

See the complete [installer safety and release contract](docs/installer.md).

### Manual package installation

If you prefer manual installation, identify the router build first:

```sh
. /etc/openwrt_release
printf 'Release: %s\nTarget: %s\nArchitecture: %s\n' \
  "$DISTRIB_RELEASE" "$DISTRIB_TARGET" "$DISTRIB_ARCH"
```

Choose an artifact from
[GitHub Releases](https://github.com/ponkcore/SSClash-PARTY/releases) only when
all values match its release description.

Download one package and its adjacent `.sha256` file to `/tmp` on the router.
For OpenWrt 25.12 APK packages:

```sh
cd /tmp
sha256sum -c ./luci-app-ssclash*.apk.sha256
apk update
apk add --allow-untrusted --force-reinstall ./luci-app-ssclash*.apk
```

For OpenWrt 24.10 IPK packages:

```sh
cd /tmp
sha256sum -c ./luci-app-ssclash*.ipk.sha256
opkg update
opkg install --force-reinstall ./luci-app-ssclash*.ipk
```

The explicit reinstall is required when upstream SSClash or an earlier PARTY
revision has the same OpenWrt package version but different downstream files.

The package name remains `luci-app-ssclash`, so PARTY upgrades an existing
SSClash installation instead of creating two services that compete for the
same firewall, DNS, controller, and `/opt/clash` paths.

When installing manually, open **Services → SSClash → Settings → Mihomo Kernel
Management** and install a compatible core if one is not already present.

### Apply a configuration

Open **Services → SSClash → Configuration**:

1. select Subscription, Proxy links, or Manual YAML;
2. enter the selected source and routing-policy settings;
3. use **Apply now** to prepare a stopped service, or **Apply & guarded start**
   for the first activation;
4. inspect the non-secret status summary and open Zashboard with **Open
   Dashboard**.

Saving source settings alone never replaces the active profile.

## Technical trust boundary

In managed Subscription and Proxy-links modes, PARTY deliberately separates
policy data from OpenWrt integration.

| Subscription or template may own | PARTY keeps under local control |
|---|---|
| Proxy nodes and credentials | Routing mode, transparent listener, and routing mark |
| Proxy groups and membership | Private authenticated controller and packaged dashboard path |
| HTTP and inline proxy providers | Loopback DNS listener and selected DNS interception mode |
| HTTP and inline rule providers | Disabled TUN, IPv6, process matching, and client listeners |
| Rules, rule order, and rule targets | Provider-cache confinement and rejection of arbitrary local file providers |
| Safe general Mihomo policy fields | Validation, activation, health checks, backups, and rollback |

A subscription cannot silently enable fake-IP. Fake-IP is supported only after
a deliberate local migration establishes and tests a compatible baseline.
Manual YAML mode remains fully user-controlled.

## Public preview limitations

- One subscription URL is supported per configuration.
- Russia is the only packaged routing template.
- Proxy links are local input and do not have a scheduled downloader.
- Managed source input is limited to 5 MiB, with additional per-line limits.
- Package availability is limited to the release matrix above.
- Share-link protocol support follows the installed Mihomo version.

## Frequently asked questions

### Will subscription groups and rules update automatically?

Yes, when the subscription returns a structurally complete profile and
**Automatic** policy is selected. If you force a PARTY template, only remote
proxies and proxy providers are imported.

### Why does Zashboard show `GLOBAL` when it is absent from my YAML?

`GLOBAL` is a built-in Mihomo controller selector. PARTY forces rule mode for
managed profiles, so ordinary traffic follows the active rule graph. Zashboard
can hide it with **Display GLOBAL by mode**.

### Why does the controller URL return HTTP 401?

The bare `http://ROUTER_IP:9090/` endpoint is the authenticated Mihomo API, not
the dashboard landing page. Use **Open Dashboard** in LuCI; it opens the
packaged Zashboard with protected fragment-based connection parameters.

### Can a subscription switch my LAN to fake-IP?

No. A remote profile cannot silently change the protected DNS model. A tested
local fake-IP baseline can be adopted deliberately and then preserved by
managed updates.

### Is PARTY limited to Cudy routers?

No. PARTY is an OpenWrt package. Cudy WBR3000UAX v1 is the current live-tested
device; other targets are supported only where an exact release artifact is
published.

### Why are the packages architecture-specific?

PARTY includes a compiled Go profile merger. The router's package architecture
must therefore match the artifact exactly.

## Documentation

| Document | Purpose |
|---|---|
| [Safe automatic installer](docs/installer.md) | One-command setup, local device detection, exact matching, manifests, checksums, conflicts, and release contract |
| [Configuration sources](docs/configuration-sources.md) | Complete user contract for Subscription, Proxy links, Manual YAML, templates, storage, and rollback |
| [Managed full-profile subscriptions](docs/managed-full-profile.md) | Trust boundary, guarded start, DNS modes, dashboard behavior, UCI settings, and recovery |
| [PARTY downstream policy](PARTY.md) | Compatibility, branch, release, privacy, and upstream relationship contracts |
| [Upstream synchronization](docs/upstream-sync.md) | Maintainer workflow for reviewing and integrating upstream changes |

## Support and responsible reports

Use [GitHub Issues](https://github.com/ponkcore/SSClash-PARTY/issues) for PARTY
bugs and feature requests. Include the PARTY version, OpenWrt release and
target, `DISTRIB_ARCH`, Mihomo version, selected source mode, reproduction
steps, and sanitized logs or status output.

Never publish subscription URLs, raw generated YAML, proxy credentials,
controller secrets, HWIDs, router passwords or keys, public IP addresses, or
configuration backups.

## Lineage and license

SSClash PARTY is an independent downstream of
[`zerolabnet/SSClash`](https://github.com/zerolabnet/SSClash). It is not an
official ZeroChaos release. PARTY preserves the original copyright notices,
upstream attribution, package compatibility, and
[GPL-2.0-only license](LICENSE).

General fixes should be proposed upstream when possible. Reproduce and report
PARTY-specific source, packaging, profile-sync, or activation problems in this
repository first.
