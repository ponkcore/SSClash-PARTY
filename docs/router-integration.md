# Router Integration and dashboard entry

Router Integration is the PARTY-owned OpenWrt runtime layer. It is shared by
every managed Subscription and Proxy-links configuration and cannot be
overridden by a provider profile or routing template.

Open **Services → SSClash → Router Integration** to edit it. Manual YAML does
not use this layer because the complete YAML is authoritative in that mode.

## DNS selection

The DNS selector offers two explicit modes:

- **Redir-host** returns ordinary DNS addresses and is the default;
- **Fake-IP** returns synthetic addresses from a configured range and enables
  the compatibility controls.

A subscription can provide upstream resolvers and DNS policy, but it cannot
change this local selection. The protected listener must remain on loopback so
that dnsmasq is the LAN-facing DNS service.

### Fake-IP compatibility checks

Before fake-IP can be activated, PARTY verifies:

- a valid IPv4 CIDR with a prefix from `/8` through `/24`;
- no overlap with an IPv4 route currently installed on the router;
- blacklist or whitelist filter behavior;
- at least the `*.lan` and `*.local` exclusions, plus the configured panel
  hostname while friendly publication is enabled;
- availability of every selected transport dependency;
- a valid generated Mihomo configuration.

The correction action adds missing mandatory exclusions and enables mapping
persistence. It does not invent application-specific IoT exclusions. Add any
device or service domains that must retain real addresses before migrating a
production LAN.

Changing DNS mode changes a runtime listener signature, so a running service
uses guarded restart rather than policy-only hot reload. The previous UCI
settings and active YAML remain available for rollback if generation,
startup, DNS, controller, or proxy-path checks fail.

## Advanced settings

The warning-marked advanced section controls:

- TPROXY, TUN, or mixed transparent transport;
- TPROXY listener port;
- Mihomo routing mark;
- TUN stack;
- automatic LAN-derived or custom private controller address;
- controller port and secret rotation;
- the always-available `/party/` dashboard entry and an optional local DNS
  alias.

Marks 1 and 3 are reserved by the PARTY firewall path. Controller and TPROXY
ports must not collide, and the DNS listener must use a different loopback
port. TUN or mixed mode requires `/dev/net/tun`.

IPv6 transparent routing is deliberately unavailable in this preview. PARTY
will not expose an enable switch until its nftables and iptables paths can
provide the same tested leak-protection contract.

## Apply transaction

The LuCI page does not write directly into the active YAML:

1. Save the form into a temporary `pending` UCI section.
2. Run compatibility checks and optional safe corrections.
3. Back up the mode-`0600` profile UCI file.
4. Promote the staged settings into the protected router section.
5. Apply any optional dnsmasq hostname and uHTTPd landing behavior; restore the
   previous UCI and panel state if this fails.
6. Regenerate the active managed source and test it with the installed Mihomo
   binary.
7. Hot-reload policy-safe changes or guarded-restart listener and firewall
   changes.
8. Restore the previous router section and panel publication if activation
   fails.

The temporary section is deleted only after successful activation.

## DNS-independent `/party/` login flow

The package installs a landing page below the ordinary uHTTPd document root
and a static link to the packaged Zashboard files. It works with the router's
existing LAN address and does not add a listener or require local DNS.

The browser flow is:

```text
http://ROUTER_IP/party/
  → ordinary LuCI login when no LuCI session exists
  → authenticated SSClash Dashboard route
  → packaged Zashboard
```

For example, a router at `192.168.10.1` uses
`http://192.168.10.1/party/`. A numeric address with a path is not treated as
a search query and is unaffected by browser DoH. The optional dnsmasq hostname
can be enabled separately, but it is secondary because browser search
heuristics or Secure DNS may bypass the router's resolver.

The authenticated route reads the controller address and token from the
active mode-`0600` YAML. It places the connection parameters after the URL
fragment marker (`#`). Fragments are handled in the browser and are not sent
as part of the HTTP request to uHTTPd.

The direct controller URL, such as `http://ROUTER_IP:9090/`, remains the
Mihomo API and correctly returns HTTP 401 without a bearer token. PARTY does
not remove controller authentication to make the dashboard convenient.

The default entry uses plain HTTP on the trusted LAN, matching the ordinary
OpenWrt LuCI listener. Browser **Not secure** labeling is expected.
Operators who require transport security can configure OpenWrt HTTPS and a
trusted local certificate separately; PARTY does not generate or silently
trust a certificate.

## Saved profiles

Named subscription profiles share one Router Integration overlay. Validating
an inactive profile does not change the active YAML, firewall, DNS, or panel.
Switching a profile applies the candidate first and changes
`main.active_profile` only after successful activation. Scheduled updates then
follow the newly active profile.

PARTY currently switches complete profiles. It does not aggregate nodes from
several subscriptions, and the packaged Zashboard remains an unmodified
upstream dashboard.
