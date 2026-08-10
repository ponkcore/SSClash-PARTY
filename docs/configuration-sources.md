# Configuration sources

SSClash PARTY supports three mutually exclusive ways to obtain a Mihomo
configuration. Select the source under **Services → SSClash → Configuration**.

| Source | Proxy ownership | Routing-policy ownership | Scheduled updates |
|---|---|---|---|
| Subscription | One selected named remote profile | Complete remote policy when available, otherwise a PARTY template | Yes, for the active profile |
| Proxy links | Local URI list | PARTY template | Not needed; the source is local |
| Manual YAML | User-edited YAML | User-edited YAML | No |

Changing and saving the source settings does not replace the active YAML.
Use the adjacent apply or guarded-start action when the new source is ready.
Managed modes expose the active YAML as a read-only preview. Manual mode makes
the editor authoritative again.

## Subscription mode

Each saved Subscription profile accepts one HTTPS URL. PARTY can retain
multiple named profiles, but exactly one is selected as the runtime and
scheduled-update source. A profile supports complete Mihomo YAML, nodes-only
Mihomo YAML, plaintext proxy URI lists, and outer Base64-encoded URI lists.
This covers Remnawave and other panels that choose a response format from the
requesting client's `User-Agent`.

PARTY discovers the source without assuming that every provider has a complete
Mihomo policy:

1. Derive the primary `User-Agent` from the installed Mihomo version. An
   explicit advanced override is retained for providers that document one.
2. Request the subscription without an HWID.
3. If the response is a usable complete or nodes-only Mihomo YAML document,
   select it.
4. Otherwise, retry without an HWID using the neutral
   `SSClash-PARTY/<version>` user agent. Panels that use a generic Base64
   fallback can return proxy URIs at this point.
5. Only when the response explicitly reports that HWID support is required,
   create or reuse one stable router ID and repeat the two requests with the
   Remnawave-compatible headers.

An explicit device-limit response is terminal: PARTY reports the exhausted
limit and does not generate another HWID or retry as a new device.

An HTML landing page, JSON document, empty response, HTTP error, or text with
no usable proxies never replaces the working configuration. HTTPS redirects
are allowed only to another HTTPS URL and are capped at three hops.

The behavior follows Remnawave's documented separation between
[Mihomo, Xray, sing-box, and generic Base64 responses](https://docs.rw/learn-en/templates/)
and its documented
[HWID response headers](https://docs.rw/features/hwid-device-limit/).

### Source classification

| Detected response | Result |
|---|---|
| Proxies or proxy providers, groups, and ordered rules | Complete Mihomo profile |
| Proxies or proxy providers without a complete policy graph | Nodes-only Mihomo source |
| Newline-separated proxy URIs | URI source |
| Base64 whose decoded value is a URI list | URI source |
| Anything else | Rejected; last-known-good stays active |

A structurally complete remote profile is not silently downgraded to a PARTY
template when its safety validation or Mihomo test fails. Such a failure may
indicate a real provider policy error, so PARTY reports it and keeps the
previous profile.

### Routing-policy selector

Subscription mode has two routing-policy choices:

- **Automatic** preserves a structurally complete remote profile. If the
  response contains only nodes or URIs, PARTY combines those proxies with the
  selected template.
- **Always use the selected PARTY template** imports only remote proxies and
  proxy providers. Remote groups, rule providers, rules, DNS policy, and other
  policy fields are deliberately discarded.

This selector makes provider-managed routing optional. A provider can add or
change groups and rules automatically only while a complete profile is active
in Automatic mode.

### Saved profiles and switching

Each named profile stores its own URL, display name, routing-policy choice,
fallback template, interval, User-Agent, HWID, and automatic-update switch.
The Configuration page exposes four distinct operations:

- **Save settings** changes stored metadata only;
- **Validate without switching** downloads, generates, tests, and caches an
  inactive profile without changing the active YAML;
- **Switch to this profile** validates the selected profile, atomically
  installs it, and changes the active-profile pointer only after successful
  runtime activation;
- **Delete profile** is available only for an inactive profile and never
  removes the last remaining profile.

If Mihomo is running, profile switching uses authenticated hot reload when the
router integration signature is unchanged and guarded restart otherwise. If
Mihomo is stopped, the validated profile becomes the next-start configuration
without starting the service. The scheduler follows only the active profile.
PARTY does not currently combine proxies from several subscriptions.

## Proxy-links mode

Proxy-links mode accepts any number of newline-separated share links. LuCI
provides individual masked rows, add/delete controls, and a bulk-paste area.
Exact duplicates are removed while preserving order.

PARTY intentionally performs only generic URI safety checks:

- one URI per line;
- a syntactically valid `scheme://value` form without whitespace;
- at most 16 KiB per line and 5 MiB for the complete source;
- `data:`, `file:`, and `javascript:` schemes are rejected.

The installed Mihomo core remains the authoritative protocol parser. PARTY
stores the normalized list in a mode-`0600`, content-addressed file below
`/opt/clash/managed-sources/` and adds one trusted local `PARTY` file provider
to the selected template. Mihomo's provider parser invokes its native URI
converter when the file is not a YAML provider document. The converter
currently handles formats such as VLESS, VMess, Shadowsocks, Trojan,
Hysteria/Hysteria2, and TUIC; actual support follows the installed Mihomo
version. See the upstream
[provider parser](https://github.com/MetaCubeX/mihomo/blob/Meta/adapter/provider/provider.go)
and
[URI converter](https://github.com/MetaCubeX/mihomo/blob/Meta/common/convert/converter.go).

Syntactically invalid lines are counted in the status panel. A syntactically
valid but unsupported scheme is left for Mihomo to reject or skip. A candidate
with no usable proxy cannot pass `mihomo -t` and is never activated.

## Manual YAML mode

Manual YAML mode retains the fully user-controlled workflow. The editor contains
the complete authoritative configuration and offers:

- save and validate without activation;
- authenticated hot reload for policy-only edits;
- full restart for listener, DNS, TProxy, TUN, or firewall integration edits.

Switching to Manual YAML stops and disables the subscription scheduler but
does not stop a working Clash service or erase the active profile. Switching
away from manual mode does not overwrite the file until an apply action
succeeds.

## PARTY templates

Built-in templates are installed below:

```text
/usr/share/ssclash-party/templates/
```

Custom templates are stored separately below:

```text
/etc/ssclash-party/templates/
```

The first packaged catalog entry is **Russia**. It is derived from the
tested router policy used during PARTY development and contains no proxy
credentials, subscription URLs, HWIDs, controller secrets, local listeners,
or arbitrary file providers. It provides 11 English policy groups, 42 public
HTTPS rule providers, and 45 ordered rules. Dedicated groups cover video,
messaging, social networks, AI, and games. Country-specific built-ins can be
added in later releases without changing the source-mode contract.

Open **Services → SSClash → Templates** to view or clone a built-in, import
complete YAML, create a visual policy, edit a custom template, restore a prior
revision, or select a template for Configuration. PARTY sanitizes every custom
save, displays removed and adjusted paths, validates the canonical result with
the installed Mihomo core, and publishes it atomically. See
[Template Studio](templates.md) for the exact contract.

Template files do not own router integration. The protected overlay still
forces the private controller, controller authentication, loopback DNS
listener, locally selected DNS mode, TPROXY/TUN mode, port, routing mark,
disabled IPv6, and confined provider caches.

## Router Integration

Open **Services → SSClash → Settings → Router Integration** to edit settings
that must be stable across every managed subscription and template:

- redir-host or fake-IP DNS mode and loopback listener;
- fake-IP range, blacklist/whitelist behavior, compatibility filters, and
  mapping persistence;
- the technical Fake-IP IP-CIDR firewall whitelist and its provider-derived
  AUTO block when whitelist mode is selected;
- TPROXY, TUN, or mixed transport, TPROXY port, routing mark, and TUN stack;
- automatic LAN-derived or explicit private controller address, port, and
  secret rotation;
- the friendly local panel hostname.

Values are staged in a temporary UCI section. The helper checks port and mark
collisions, private listener scope, TUN availability, fake-IP CIDR validity,
overlap with current IPv4 routes, mandatory `*.lan` and `*.local` exclusions,
and the panel hostname while friendly publication is enabled. The UI can add
those safe exclusions and enable mapping
persistence. Only then does PARTY generate and validate a candidate.

Subscriptions cannot change these values. Manual YAML is intentionally
authoritative and therefore does not use Router Integration; edit and restart
the complete YAML directly in that mode. IPv6 transparent routing remains
unavailable until both supported firewall backends can enforce complete leak
protection.

## Transaction and rollback

Every managed apply uses the same transaction:

1. Lock against concurrent operations.
2. Fetch or read the selected proxy source with strict size limits.
3. Classify and normalize the source.
4. Select remote policy or a trusted PARTY template.
5. Apply the router-owned safety overlay.
6. Test the exact candidate with the installed Mihomo binary.
7. Back up and atomically install only a changed candidate.
8. Hot-reload policy-only changes or use a guarded restart for protected
   runtime changes.
9. Verify the authenticated controller, router DNS, and a proxy-path probe.
10. Restore the previous profile on reload or health-check failure.

PARTY also fingerprints the selected mode, profile ID, routing choice,
template, router integration overlay, and source before generation. If another
browser session or an operator changes those settings while a download or
Mihomo test is in progress, the stale candidate is discarded instead of
replacing the newly selected source.

The scheduler runs only in Subscription mode. It never starts a deliberately
stopped Clash service. A local proxy-link list changes only when the user saves
it, so it does not need an hourly downloader.

## Stored state

| Path | Contents | Expected mode |
|---|---|---|
| `/etc/config/ssclash_profile` | Source mode, named subscription profiles, active-profile pointer, router integration, intervals, and optional HWIDs | `0600` |
| `/etc/ssclash-party/links.txt` | Local proxy URI list | `0600` |
| `/etc/ssclash-party/templates/` | Custom canonical templates, metadata, bounded revision history, and recoverable deleted snapshots | directory `0700`, files `0600` |
| `/opt/clash/managed-sources/` | Content-addressed URI source used by Mihomo | directory `0700`, files `0600` |
| `/opt/clash/config.yaml` | Active last-known-good Mihomo profile | `0600` |
| `/opt/clash/profile-backups/` | Up to five previous active profiles | directory `0700`, files `0600` |
| `/opt/clash/profile-cache/` | Validated per-profile candidates and source revisions | directory `0700`, files `0600` |
| `/tmp/ssclash-profile-sync/status.json` | Non-secret operation state and structural counts | runtime-only |

The subscription URL, proxy URIs, raw YAML, controller secret, and proxy
credentials are never included in the status document or normal log messages.

## Initial limitations

- Only one saved subscription profile can be active and scheduled at a time;
  multi-subscription aggregation is not implemented.
- Russia is the only packaged routing template.
- Proxy links are local static input; only subscriptions are scheduled.
- The 5 MiB source limit is fixed.
- PARTY does not reimplement Mihomo's protocol converters, so an older core may
  reject a share-link feature accepted by a newer core.
