# Managed full-profile subscriptions

> This document describes the complete-profile branch of PARTY's broader
> source system. For source discovery, nodes-only subscriptions, Base64/URI
> fallback, proxy-link input, templates, and Manual YAML mode, start with
> [Configuration sources](configuration-sources.md).

SSClash can consume a complete Mihomo YAML profile from an HTTPS
subscription. This workflow is intended for providers and control panels,
including Remnawave, that generate nodes, proxy groups, rule providers, and
ordered rules as one document.

The managed workflow is deliberately different from a node-only
`proxy-provider`:

- the remote profile controls the routing policy graph;
- a local overlay controls the OpenWrt runtime integration;
- every candidate is parsed and tested before activation;
- a running Mihomo instance is hot-reloaded and health-checked;
- a failed update restores the last known-good profile.

## Trust boundary

A valid remote profile is still trusted to control outbound behavior. It can
change:

- inline proxy nodes and their credentials;
- proxy groups and group membership;
- HTTP and inline proxy providers;
- HTTP and inline rule providers;
- rules, rule order, and rule targets;
- safe general Mihomo policy fields.

The subscription cannot replace the router-critical settings below:

| Area | Local behavior |
|---|---|
| Routing mode | Forced to `rule` |
| Transparent listener | Forced to `tproxy-port: 7894` |
| Routing loop prevention | Forced to `routing-mark: 2` |
| Controller | Private, loopback, or link-local address only |
| Controller secret | Safe local token preserved; missing or unsafe token replaced with `crypto/rand` |
| Dashboard files | Forced to the packaged `./ui` directory |
| DNS listener | Loopback address only |
| DNS interception mode | Protected by the local `dns_mode` setting |
| Fake-IP cache persistence | Preserved from the local profile settings |
| IPv6 | Disabled |
| TUN and client listeners | Removed |
| Process matching | Forced off |
| Provider cache paths | Confined below `./managed-providers/` |

Remote fields that can open or alter listeners are removed. This includes
TUN, mixed/HTTP/SOCKS/redir ports, custom inbounds and listeners, controller
TLS/Unix/pipe settings, CORS, authentication, and listener TLS settings.

Remote `file` providers are rejected. A downloaded profile cannot safely
assume that arbitrary local files exist on the router. HTTP and inline
providers are accepted, and their cache paths are rewritten into SSClash's
managed directory.

## LuCI workflow

Open **Services → SSClash → Configuration** and use the
**Configuration Source** card:

1. Select **Subscription** and paste the HTTPS URL.
2. Choose **Automatic** to retain a complete remote policy, or force the
   selected PARTY template to import only proxies.
3. Choose an update interval. The minimum is 300 seconds; 3,600 seconds is
   one hour.
4. Enable automatic updates if desired.
5. Select **Sync now** to download and validate without starting a stopped
   service.
6. Select **Sync & guarded start** for the first activation.

The ordinary **Start Service** button also uses the guarded managed start when
a managed source is saved.

The YAML editor is a read-only active-profile preview in managed modes. Select
**Manual YAML** before editing it. Merely changing source settings never
replaces the active file.

## Update transaction

Each manual or scheduled synchronization performs the following transaction:

1. Acquire an operation lock.
2. Read the URL from the mode-`0600` UCI file.
3. Allow at most three HTTPS-to-HTTPS redirects and reject every other URL
   scheme.
4. Apply size, timeout, and retry limits.
5. Try the installed Mihomo user agent and a neutral PARTY fallback without
   HWID headers.
6. Retry with a stable HWID only when the server explicitly requires it.
7. Classify the result as complete YAML, nodes-only YAML, URI list, or
   unsupported input.
8. Remove unsafe remote runtime fields and apply the local router overlay.
9. Confine all remote provider cache paths.
10. Test the candidate with `mihomo -t`.
11. Leave the active file untouched when the generated output is unchanged.
12. Otherwise, back up and atomically replace the active configuration.
13. Hot-reload a running core through its authenticated controller API.
    If protected listener, controller, TProxy, or DNS interception settings
    changed, perform a guarded restart instead.
14. Check the controller, router DNS, and a configured proxy group.
15. Restore and reload the previous profile if any check fails.

At most five dated configuration backups are retained under:

```text
/opt/clash/profile-backups/
```

The scheduled updater never starts a deliberately stopped SSClash service.
At boot, SSClash starts from the last known-good local configuration; the
updater checks the remote source after the network has had time to initialize.

## Guarded first start

The guarded start disables boot enablement before changing network routing and
starts a watchdog. SSClash is enabled at boot only after all of these checks
pass:

- the procd service is running;
- the authenticated Mihomo controller responds;
- DNS resolution through the router succeeds;
- an HTTP connectivity probe succeeds through a configured proxy group.

If confirmation does not arrive before the watchdog deadline, SSClash is
stopped and disabled so that direct routing can recover.

## DNS modes

The local `dns_mode` option accepts:

- `preserve` — retain the tested mode from the current router config;
- `redir-host` — explicitly force normal address responses;
- `fake-ip` — preserve an already tested fake-IP baseline.

`fake-ip` cannot be enabled only by a remote subscription. Before selecting
it, the current local configuration must already contain a tested
`enhanced-mode: fake-ip` baseline, including a suitable private range and
compatibility filters.

This restriction prevents an unattended subscription update from changing
the DNS model for every LAN client. It does not prohibit fake-IP. A deliberate
local migration can establish and test the baseline, after which managed
updates preserve it.

## Dashboard access and `GLOBAL`

**Open Dashboard** reads the private controller address and secret from the
active configuration and opens the packaged dashboard setup route. Connection
parameters are placed after the URL fragment marker (`#`), so the browser does
not send the secret in the HTTP request path.

The controller must remain authenticated. Removing the secret would allow LAN
clients to inspect connections, change selectors, or invoke other controller
operations.

Mihomo exposes a built-in `GLOBAL` selector through its controller API even
when the YAML has no group named `GLOBAL`. The managed overlay forces
`mode: rule`, so normal traffic follows the imported rule graph rather than
that built-in selector. Dashboards may offer a client-side option to display
`GLOBAL` only while global mode is active.

## Advanced UCI settings

The settings are stored in:

```text
/etc/config/ssclash_profile
```

The package installs this file with mode `0600`.

| Option | Default | Purpose |
|---|---|---|
| `source_mode` | `subscription` | `subscription`, `links`, or `manual` |
| `rules_mode` | `auto` | Preserve complete remote policy or force a template |
| `template_id` | `russia` | Trusted PARTY template catalog ID |
| `enabled` | `0` | Run the scheduled updater |
| `url` | empty | Adaptive HTTPS subscription URL |
| `interval` | `3600` | Update interval in seconds |
| `user_agent` | `auto` | Installed Mihomo user agent or explicit override |
| `hwid` | empty | Stable Remnawave `x-hwid`, generated only when required |
| `device_os` | `OpenWrt` | Optional Remnawave device OS header |
| `device_model` | automatic | Optional Remnawave device model header |
| `lan_interface` | `lan` | Logical interface used to derive the controller |
| `controller` | automatic | Explicit private controller address and port |
| `controller_port` | `9090` | Port used during automatic derivation |
| `dns_listen` | `127.0.0.1:7874` | Protected loopback Mihomo DNS listener |
| `dns_mode` | `preserve` | Protected DNS interception mode |
| `health_url_primary` | Google 204 endpoint | Primary HTTPS proxy probe |
| `health_url_secondary` | Cloudflare 204 endpoint | Fallback HTTPS proxy probe |

Header values are length-limited and cannot contain carriage returns or line
feeds. The subscription URL is passed to curl through standard input rather
than as a process argument. Subscription request headers and controller
authorization are passed through mode-`0600` temporary files instead of
exposing private values in curl's argument list.

## Status and recovery

Runtime status is available through LuCI and:

```sh
/usr/libexec/ssclash-profile-sync status
```

The status document contains structural counts and hashes, but not the
subscription URL, controller secret, proxy credentials, or raw YAML.

To stop scheduled updates without stopping a working proxy:

```sh
uci set ssclash_profile.main.enabled='0'
uci commit ssclash_profile
/etc/init.d/ssclash-profile-sync stop
/etc/init.d/ssclash-profile-sync disable
```

To restore a known-good file manually, stop SSClash, copy the selected backup
to `/opt/clash/config.yaml`, validate it, and use a guarded start. Do not
publish backups: they contain the complete private profile.

## Package architecture

The structural merger is a compiled Go executable. Consequently,
`luci-app-ssclash` is architecture-specific in builds that contain this
feature. Install only a package whose OpenWrt package architecture matches:

```sh
. /etc/openwrt_release
printf '%s\n' "$DISTRIB_ARCH"
```

OpenWrt 25 uses APK packages. OpenWrt 24.10 and older supported builds use IPK
packages.
