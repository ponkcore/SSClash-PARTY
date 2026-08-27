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
| Transparent transport | Locally selected TPROXY, TUN, or mixed mode; TPROXY defaults to port `7894` |
| Routing loop prevention | Locally selected safe mark; defaults to `routing-mark: 2`, while marks 1 and 3 remain reserved |
| Controller | Private, loopback, or link-local address only |
| Controller secret | Safe local token preserved; missing or unsafe token replaced with `crypto/rand` |
| Dashboard files and CORS | Forced to packaged `./ui` files and exact local panel/controller origins |
| DNS listener | Loopback address only |
| DNS interception mode | Deliberately selected redir-host or fake-IP under Router Integration |
| Fake-IP baseline | Local range, filter behavior, compatibility exclusions, and persistence |
| IPv6 | Disabled until transparent routing has complete leak protection |
| Remote TUN and client listeners | Removed; only the locally selected TUN definition may be generated |
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
2. Select an existing saved profile or use **Add profile**.
3. Choose **Automatic** to retain a complete remote policy, or force the
   selected PARTY template to import only proxies.
4. Choose an update interval. The minimum is 300 seconds; 3,600 seconds is
   one hour.
5. Enable automatic updates if desired.
6. Select **Validate without switching** to test an inactive profile without
   changing the runtime, or **Switch to this profile** to make it active.
7. Select **Sync now** to download and apply the active profile without starting a stopped
   service.
8. Select **Sync & guarded start** for the first activation.

The ordinary **Start Service** button also uses the guarded managed start when
a managed source is saved.

The YAML editor is a read-only active-profile preview in managed modes. Select
**Manual YAML** before editing it. Merely changing source settings never
replaces the active file.

Each named profile retains its own URL, policy mode, template, interval,
User-Agent, and optional HWID. Only the active profile is scheduled. PARTY can
save and switch profiles, but it does not yet aggregate several subscriptions
into one proxy pool.

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
15. Commit the new active-profile pointer only after successful activation.
16. Restore and reload the previous profile if any check fails.

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

LuCI never holds the guarded transaction inside a single rpcd `file.exec`
call: OpenWrt's rpcd kills exec'd processes after a configurable
server-side timeout (30 seconds in the stock configuration), which would
orphan the start watchdog and later stop a healthy service. The interface
instead kicks a detached `sync-start-async` run that writes a working
status record before the background child exists, and polls that record
until it leaves the working state. The watchdog itself records a
`watchdog_timeout` error status before stopping and disabling the service.
Command-line `sync-start` and `start-guarded` remain synchronous.

## Router Integration and DNS modes

Open **Services → SSClash → Settings → Router Integration** for the protected
runtime overlay. Its DNS selector exposes:

- `redir-host` — explicitly force normal address responses;
- `fake-ip` — generate a locally controlled fake-IP baseline.

When fake-IP is selected, PARTY checks the configured IPv4 CIDR against
current routes, validates filter mode and persistence, and requires `*.lan`
and `*.local` to bypass fake addressing. The optional panel hostname is also
required while its DNS alias is enabled. The UI can add missing mandatory
exclusions before the actual activation. Mihomo
validation, guarded restart, health checks, and rollback still apply.

This restriction prevents an unattended subscription update from changing
the DNS model for every LAN client. It does not prohibit fake-IP; it moves the
choice into an explicit router-owned workflow. The same page contains an
advanced, warning-marked section for transparent transport, ports, routing
mark, TUN stack, controller address, token rotation, and panel hostname.

Manual YAML remains authoritative and does not inherit this overlay. The
legacy internal `preserve` value can retain an already tested baseline during
migration, but it is not offered as a new UI selection.

## Dashboard access and `GLOBAL`

**Open Dashboard** reads the private controller address and secret from the
active configuration and opens the packaged dashboard setup route. Connection
parameters are placed after the URL fragment marker (`#`), so the browser does
not send the secret in the HTTP request path. The authenticated route remains
internal and is not shown as a duplicate LuCI navigation tab.

The recommended `http://ROUTER_IP/party/` entry needs no DNS. An
unauthenticated request opens the standard LuCI login; after successful
authentication, LuCI continues to the protected dashboard route and then
Zashboard. An optional local hostname can be published through dnsmasq, but
browser search heuristics and Secure DNS make it less reliable. Direct
`http://ROUTER_IP:9090/` remains a token-protected API endpoint and correctly
returns HTTP 401 without authorization. The dashboard entry is ordinary LAN
HTTP unless the operator configures HTTPS separately, so browser **Not secure**
labeling is expected.

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

| Section / option | Default | Purpose |
|---|---|---|
| `main.source_mode` | `subscription` | `subscription`, `links`, or `manual` |
| `main.active_profile` | `default` | Named subscription selected for runtime and scheduling |
| `subscription.name` | section ID | User-facing saved-profile name |
| `subscription.rules_mode` | `auto` | Preserve complete remote policy or force a template |
| `subscription.template_id` | `russia` | Trusted PARTY template catalog ID |
| `subscription.enabled` | `0` | Schedule updates when this profile is active |
| `subscription.url` | empty | Adaptive HTTPS subscription URL |
| `subscription.interval` | `3600` | Update interval in seconds |
| `subscription.user_agent` | `auto` | Installed Mihomo user agent or explicit override |
| `subscription.hwid` | empty | Stable Remnawave `x-hwid`, generated only when required |
| `router.dns_listen` | `127.0.0.1:7874` | Protected loopback Mihomo DNS listener |
| `router.dns_mode` | `redir-host` | Protected DNS interception mode |
| `router.proxy_mode` | `tproxy` | `tproxy`, `tun`, or `mixed` |
| `router.tproxy_port` | `7894` | Protected transparent listener port |
| `router.routing_mark` | `2` | Mihomo loop-prevention mark |
| `router.controller_mode` | `auto` | Follow the current LAN address or use a private override |
| `router.controller_port` | `9090` | Protected controller port |
| `router.panel_enabled` | `0` | Optional dnsmasq hostname; `/party/` remains available |
| `router.panel_hostname` | `panel.router` | Optional LAN hostname; prefer `ROUTER_IP/party/` |
| `main.lan_interface` | `lan` | Logical interface used for controller and panel derivation |
| `main.health_url_primary` | Google 204 endpoint | Primary HTTPS proxy probe |
| `main.health_url_secondary` | Cloudflare 204 endpoint | Fallback HTTPS proxy probe |

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
profile="$(uci -q get ssclash_profile.main.active_profile)"
uci set "ssclash_profile.$profile.enabled=0"
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
