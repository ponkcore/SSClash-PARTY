# Template Studio

Template Studio manages the routing-policy half of a generated Mihomo profile.
Open it at **Services → SSClash → Templates**. A template may define proxy
groups, rule providers, ordered rules, safe DNS upstream policy, hosts,
sniffing policy, and sub-rules. It never owns proxy nodes or the OpenWrt runtime
integration layer.

## Storage model

Packaged templates are immutable:

```text
/usr/share/ssclash-party/templates/catalog.json
/usr/share/ssclash-party/templates/russia.yaml
```

User-created templates persist separately:

```text
/etc/ssclash-party/templates/<id>/template.yaml
/etc/ssclash-party/templates/<id>/metadata.json
/etc/ssclash-party/templates/<id>/history/<revision>.yaml
```

The custom root and template directories use mode `0700`; YAML and metadata
files use `0600`. PARTY retains up to 20 prior YAML revisions per template.
Deleting a custom template moves its entire directory below protected `.trash`
storage instead of erasing it. Built-ins cannot be edited or deleted, but they
can be cloned under a new stable ID.

Metadata writes use an expected revision. If another LuCI session updates the
same template after the editor loads it, the stale save is rejected rather
than overwriting the newer revision.

## YAML import and sanitation

YAML import accepts a mapping in YAML or JSON syntax. PARTY does not publish
the pasted document directly. **Prepare & inspect** performs these operations:

1. Parse with the same bounded YAML implementation used by profile generation.
2. Keep only the portable policy sections supported by the template contract.
3. Remove inline proxy nodes, proxy providers, subscription URLs, credentials,
   and concrete node names.
4. Remove Router Integration fields, including listeners, controller settings,
   controller secrets, TUN/TPROXY/routing settings, IPv6 behavior, DNS listener,
   DNS interception mode, fake-IP range and filters, and mapping persistence.
5. Accept rule providers only as credential-free HTTPS providers or native
   Mihomo `inline` providers. Provider headers and cache paths are discarded.
   A local `file` provider is removed because its path is not portable.
6. Remove ordered rules that depend on a removed provider or target a concrete
   node. Require the final rule to be an explicit `MATCH` or `FINAL` fallback.
7. Normalize source-facing proxy groups so imported subscription or share-link
   nodes can populate them without embedding node names in the template.
8. Produce canonical YAML and a path-by-path sanitation report.

Canonicalization does not preserve comments or hand formatting. Review the
shown result when the report contains changes. A save repeats sanitation,
builds a temporary node-bearing candidate, and runs the installed Mihomo
binary in native configuration-test mode. Only a successful candidate becomes
the next atomic revision.

An HTTPS rule-provider URL must have a host and must not contain embedded user
information, query credentials, or a fragment. Health-check URLs follow the
same rule. Unsafe or missing health checks on test groups are replaced with the
PARTY HTTPS default. Runtime provider cache paths are generated later below
`/opt/clash/managed-providers/`; a template cannot choose them.

## Visual editor

The visual and YAML editors operate on one canonical document. The visual mode
can:

- add, remove, and reorder proxy groups;
- choose `select`, `url-test`, `fallback`, `load-balance`, or `relay` group
  types;
- reference another template group or a Mihomo built-in policy;
- include every node supplied by the active subscription or proxy-link source;
- add HTTPS or inline rule providers with domain, IP-CIDR, or classical
  behavior;
- build common domain, IP, process, port, network, and `RULE-SET` rows from
  type/value/target controls, use an advanced raw row for compound Mihomo
  rules, and reorder every row before the final fallback.

Switching from YAML to visual mode prepares and sanitizes the current YAML
first. Switching back generates canonical YAML from the visual document. Safe
sections not exposed as visual controls, such as an imported `dns` or `sniffer`
mapping, remain in the shared document.

## Legacy local lists

The former Rulesets page created standalone files below `/opt/clash/lst/`.
Those files did not automatically create a provider or an ordered routing rule.
The visible Rulesets tab is therefore replaced by Templates, while its old URL
remains a hidden compatibility alias.

Template Studio lists retained `.txt` files as **unattached legacy lists**.
Inside a custom visual template, select a file and its behavior to copy its
non-comment entries into a native Mihomo `inline` rule provider. PARTY retains
the original file and does not guess the policy target; add and position the
corresponding `RULE-SET` rule explicitly.

The special `fakeip-whitelist-ipcidr.txt` file is not a routing template list.
It belongs to the transparent firewall path and is edited under
**Settings → Router Integration → Fake-IP compatibility wizard** when
whitelist mode is selected.

## Selection and activation

**Select** records a template ID for Configuration but does not force a saved
subscription from Automatic policy into template policy. The selected template
is used when:

- Proxy links is the source;
- a subscription response contains nodes or share URIs without a complete
  policy; or
- **Always use the selected PARTY template** is enabled for that subscription.

Editing a selected template does not immediately restart Mihomo. The next
validate, apply, profile switch, or scheduled subscription update uses the new
revision. Profile generation fingerprints both the template ID and its content
hash before and after candidate construction; a concurrent edit causes the
stale candidate to be discarded.

Manual YAML remains authoritative and bypasses Template Studio and Router
Integration overlays.
