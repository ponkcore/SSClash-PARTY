<p align="right">
  <strong>English</strong> · <a href="README.ru.md">Русский</a>
</p>

<h1 align="center">SSClash PARTY</h1>

<h3 align="center">Mihomo for OpenWrt without hand-editing YAML</h3>

<p align="center">
  <a href="https://github.com/ponkcore/SSClash-PARTY/actions/workflows/build.yml?query=branch%3Aparty"><img alt="Build and test" src="https://github.com/ponkcore/SSClash-PARTY/actions/workflows/build.yml/badge.svg?branch=party"></a>
  <img alt="Status: Stable" src="https://img.shields.io/badge/status-stable-brightgreen">
  <a href="LICENSE"><img alt="License: GPL-2.0" src="https://img.shields.io/badge/license-GPL--2.0-blue.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/ponkcore/SSClash-PARTY/releases/latest">Download</a>
  · <a href="#quick-start">Quick start</a>
  · <a href="#documentation">Documentation</a>
</p>

SSClash PARTY is a LuCI application that turns a subscription or a list of
VLESS, VMess, Shadowsocks, Trojan, Hysteria, TUIC, and other proxy links into a
working Mihomo setup. Pick a routing template, apply it, and use the proxy — no
YAML editing is required. Complete manual YAML remains available for advanced
setups.

PARTY validates every generated configuration with the router's Mihomo core,
activates it transactionally, and rolls back to the last known-good profile if
validation, reload, restart, or health checks fail.

> [!IMPORTANT]
> Install only a package that exactly matches the OpenWrt release, target,
> package architecture, and package format of the router. Keep a current
> OpenWrt backup before installing or updating network software.

## Quick start

### Automatic installation — recommended

Connect to the OpenWrt router over SSH as `root` and paste one command:

```sh
wget -qO /tmp/ssclash-party-install.sh https://github.com/ponkcore/SSClash-PARTY/releases/latest/download/ssclash-party-install.sh && sh /tmp/ssclash-party-install.sh install
```

The installer first performs a read-only device check. It accepts only an
exact package from the checksum-bound release catalog, verifies the manifest
and package SHA-256 checksums, checks free space, memory, firewall, package
manager, and conflicting proxy software, and never flashes firmware. A valid
Mihomo core is retained; a pinned core is installed only when one is missing.

On a first installation, Clash remains stopped until a configuration is
applied. An update preserves PARTY configuration and the previous running and
boot-enabled state.

Run only the compatibility report:

```sh
wget -qO /tmp/ssclash-party-install.sh https://github.com/ponkcore/SSClash-PARTY/releases/latest/download/ssclash-party-install.sh && sh /tmp/ssclash-party-install.sh doctor
```

Automatic installation means exact matching, not device guessing. An
unsupported OpenWrt build, architecture, firewall, resource level, or conflict
causes a safe stop before persistent changes. See the complete
[installer safety contract](docs/installer.md).

### Apply your first configuration

Open **Services → SSClash → Configuration**:

1. choose **Subscription**, **Proxy links**, or **Manual YAML**;
2. paste the subscription or proxy links;
3. keep **Russia** or select another installed routing template;
4. use **Apply now** for a stopped service, or **Apply & guarded start** for
   the first activation;
5. open Zashboard with **Open Dashboard**.

Saving source fields alone does not replace the active configuration. PARTY
always builds and validates a candidate first.

### Update PARTY from LuCI

Open **Services → SSClash → Settings → Software Updates → PARTY**. The card shows
the installed version, the latest stable version, and whether an update is
available. **Install update** runs the same exact-match and checksum-verified
installer in the background. LuCI may reconnect briefly while the package and
services are restored. The adjacent **Mihomo Kernel** card manages the proxy
engine separately without presenting it as another Settings section.

## Why PARTY

Mihomo is powerful, but a conventional router setup often starts with a large
YAML file. Users must merge proxy credentials, groups, ordered rules, DNS,
transparent routing, and controller settings by hand. Subscription providers
also return different formats depending on the client: a complete Mihomo
config, nodes-only YAML, plain share links, or a Base64-encoded link list.

PARTY makes those cases a normal LuCI workflow:

- paste a subscription and let PARTY detect its actual format;
- paste any number of compatible proxy links and attach them to a trusted
  routing template;
- keep several named subscriptions and switch the active one transactionally;
- use ready-made groups and rules without maintaining YAML;
- retain a complete YAML config from the subscription when it already contains
  useful provider groups, rules, and routing;
- keep router-critical DNS, TPROXY/TUN, controller, and cache settings under
  local control;
- test the exact candidate with Mihomo before it can become active.

## Configuration sources

PARTY exposes three mutually exclusive sources.

| Source | What you provide | Routing | Scheduled updates |
|---|---|---|---|
| **Subscription** | One or more saved HTTPS subscriptions; one active at a time | Keep complete groups, rules, and routing from the subscription, or force the selected PARTY template | Yes, for the active profile |
| **Proxy links** | A newline-separated list of Mihomo-compatible share links | Selected PARTY template | No; the source is local |
| **Manual YAML** | A complete Mihomo configuration | Fully controlled by the user | No |

### Adaptive subscriptions

PARTY negotiates the subscription format with a Mihomo identity and a neutral
fallback. It starts without an HWID and adds stable Remnawave-compatible device
headers only when the server requires them.

It recognizes:

- complete Mihomo YAML with proxies, groups, rule providers, and ordered rules;
- nodes-only Mihomo YAML;
- plaintext proxy URIs;
- an outer Base64-encoded URI list.

With **Automatic** routing, a complete YAML config from the subscription keeps
its provider-supplied groups, rules, and routing, so later changes arrive with
normal subscription updates. Nodes-only YAML and URI responses use the
selected local template. Choose **Always use the selected PARTY template** to
import only proxy nodes even when the subscription contains complete routing.

### Saved subscription profiles

**Add profile** stores another provider or account with its own URL, routing
choice, template, update interval, User-Agent, and optional HWID. **Validate
without switching** tests an inactive profile without touching the active
configuration. **Switch to this profile** performs a transactional hot reload
or guarded restart; a deliberately stopped service remains stopped.

Only the active profile receives scheduled updates. Combining nodes from
several subscriptions into one runtime pool is not implemented yet.

### Proxy links

Paste one link per line. PARTY normalizes and deduplicates VLESS, VMess,
Shadowsocks, Trojan, Hysteria/Hysteria2, TUIC, and other URI formats supported
by the installed Mihomo core, then places the resulting nodes into the selected
template. Safety limits bound total input size and individual rows, but the UI
has no fixed row count.

### Manual YAML

The built-in editor remains available when complete control is required. In
this mode the YAML is authoritative: PARTY does not regenerate it or schedule
subscription updates.

## Template Studio

Open **Services → SSClash → Templates** to manage reusable routing without
mixing it with proxy credentials or router listeners. The built-in **Russia**
template is immutable and can be cloned. A custom template can be imported as
complete YAML or created visually with proxy groups, HTTPS or inline rule
providers, and ordered rules.

Before saving, PARTY canonicalizes and sanitizes the document. Proxy nodes,
provider credentials, controller/TUN/TPROXY/listener fields, fake-IP mode,
arbitrary cache paths, and non-portable file providers are removed from the
template layer. The installed Mihomo core validates the result before an atomic
revision is published. Earlier revisions can be restored, and deleted custom
templates move to protected recovery storage.

## Safe activation and router integration

Every managed apply follows the same transaction:

<p align="center">
  <strong>Fetch or read</strong> → <strong>Classify</strong> → <strong>Merge protected settings</strong> → <strong>Test with Mihomo</strong> → <strong>Apply and health-check</strong>
</p>

Policy-only changes use an authenticated hot reload. Listener, DNS mode,
transparent transport, or firewall changes use a guarded restart. PARTY checks
the controller, router DNS, and a real proxy path after activation and restores
the previous configuration if any required check fails. A scheduled update
never starts a service that the operator stopped.

Router-owned controls live under **Settings → Router Integration**:

- switch between `redir-host` and `fake-ip` deliberately;
- run fake-IP route, range, filter, persistence, LAN, and panel compatibility
  checks before activation;
- configure TPROXY port, routing mark, DNS listener, controller address and
  secret, TUN, and IPv6 transport in the guarded advanced section;
- keep these values protected from subscription changes.

In managed modes, subscriptions and templates may own proxy nodes, groups,
HTTP/inline providers, ordered rules, and safe general Mihomo fields. PARTY
retains routing mode, transparent listeners, marks, controller authentication,
local DNS behavior, provider-cache confinement, validation, backup, health
checks, and rollback. Manual YAML is intentionally outside this managed
boundary.

## Dashboard access

Use **Open Dashboard** in Configuration or browse to
`http://ROUTER_IP/party/`. The normal LuCI login appears first; after successful
authentication PARTY opens the packaged Zashboard without requiring a port in
the browser address. On plain LAN HTTP the browser may label the page **Not
secure**, while the Mihomo controller itself still requires its private token.

PARTY enables Zashboard's mode-aware `GLOBAL` display by default in each
browser. Managed profiles run in `rule` mode, so the built-in `GLOBAL` selector
stays hidden there. A user can still change this preference in Zashboard.

## Included capabilities

| Capability | What it means |
|---|---|
| Adaptive source discovery | Complete YAML, nodes-only YAML, plaintext URIs, and Base64 URI lists share one subscription workflow |
| Saved subscription profiles | Store, validate, rename, and transactionally switch subscriptions without exposing their URLs |
| Template Studio | Create, clone, sanitize, visually edit, validate, version, restore, and select portable routing policies |
| Guarded activation | Mihomo validation, atomic replacement, post-apply health checks, and last-known-good rollback |
| Router Integration | DNS mode, fake-IP compatibility, transparent transport, loop prevention, and controller settings remain local |
| Remnawave compatibility | Client negotiation and optional stable HWID headers without creating new identities on device-limit errors |
| Authenticated dashboard | LuCI login followed by packaged Zashboard at `/party/`, with mode-aware `GLOBAL` hidden by default |
| Stable LuCI updates | Installed/latest versions and exact-match, checksum-verified background updates |

## Supported packages

The current stable release,
[`v4.7.0-party.11`](https://github.com/ponkcore/SSClash-PARTY/releases/tag/v4.7.0-party.11),
publishes these architecture-specific packages:

| OpenWrt release | Target | Package architecture | Format | Validation |
|---|---|---|---|---|
| 25.12.5 | `mediatek/filogic` | `aarch64_cortex-a53` | APK | CI-built, package-inspected, and hardware-tested |
| 25.12.5 | `x86/64` | `x86_64` | APK | CI-built and package-inspected |
| 24.10.8 | `x86/64` | `x86_64` | IPK | CI-built and package-inspected |

A generic “ARM64” or “x86-64” CPU description is insufficient. Match the
exact release, target, `DISTRIB_ARCH`, and package format. These are application
packages, not firmware images; PARTY never flashes the router.

### Manual package installation

Identify the router build first:

```sh
. /etc/openwrt_release
printf 'Release: %s\nTarget: %s\nArchitecture: %s\n' \
  "$DISTRIB_RELEASE" "$DISTRIB_TARGET" "$DISTRIB_ARCH"
```

Download exactly one matching package and its adjacent `.sha256` file from
[GitHub Releases](https://github.com/ponkcore/SSClash-PARTY/releases). For an
OpenWrt 25.12 APK:

```sh
cd /tmp
sha256sum -c ./luci-app-ssclash*.apk.sha256
apk update
apk add --allow-untrusted --force-reinstall ./luci-app-ssclash*.apk
```

For an OpenWrt 24.10 IPK:

```sh
cd /tmp
sha256sum -c ./luci-app-ssclash*.ipk.sha256
opkg update
opkg install --force-reinstall ./luci-app-ssclash*.ipk
```

The package identifier remains `luci-app-ssclash` for installation and upgrade
compatibility. A forced reinstall is required when an existing compatible
package has the same OpenWrt package version but different files.

## Current limitations

- Several subscriptions can be saved, but only one is active and scheduled at
  a time; multi-subscription aggregation is not implemented.
- Russia is the only packaged routing template today.
- Proxy links are local input and have no scheduled downloader.
- Managed source input is limited to 5 MiB, with additional per-line limits.
- Package availability is limited to the release matrix above.
- Share-link protocol support follows the installed Mihomo version.

## Frequently asked questions

### Will groups and rules from my subscription update automatically?

Yes, when the subscription returns a structurally complete Mihomo config and
**Automatic** routing is selected. If a PARTY template is forced, updates
import proxy nodes and providers while routing continues to come from the
selected local template.

### Can I save and switch between several subscriptions?

Yes. Each named profile is independent and can be validated while inactive.
Switching is transactional. Only one profile is active at a time; merging
several subscriptions into one pool is a future feature.

### Why are packages architecture-specific?

PARTY includes a compiled profile merger. The router's OpenWrt package
architecture must therefore match the release artifact exactly.

## Documentation

| Document | Purpose |
|---|---|
| [Safe automatic installer](docs/installer.md) | One-command setup, device detection, exact matching, manifests, checksums, conflicts, stable updates, and release contract |
| [Configuration sources](docs/configuration-sources.md) | Subscription, Proxy links, Manual YAML, templates, storage, and rollback |
| [Template Studio](docs/templates.md) | Template CRUD, YAML sanitation, visual editing, history, storage, and legacy-list migration |
| [Router Integration and dashboard](docs/router-integration.md) | redir-host/fake-IP, compatibility checks, transparent transport, controller protection, and `/party/` login flow |
| [Managed subscriptions](docs/managed-full-profile.md) | Trust boundary, guarded start, DNS modes, dashboard behavior, UCI settings, and recovery |
| [Maintainer policy](PARTY.md) | Compatibility, branch, release, privacy, attribution, and maintenance contracts |
| [Source synchronization](docs/upstream-sync.md) | Maintainer-only workflow for reviewing and integrating source changes |

## Support and responsible reports

Use [GitHub Issues](https://github.com/ponkcore/SSClash-PARTY/issues) for bugs
and feature requests. Include the PARTY version, OpenWrt release and target,
`DISTRIB_ARCH`, Mihomo version, selected source mode, reproduction steps, and
sanitized status output.

Never publish subscription URLs, generated YAML, proxy credentials,
controller secrets, HWIDs, router passwords or keys, public IP addresses, or
configuration backups.

## License

SSClash PARTY is released under the [GPL-2.0-only license](LICENSE). Required
copyright and source-lineage notices are retained in the licensed source and
maintainer documentation.
