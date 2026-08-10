# SSClash PARTY installer

The PARTY installer is a conservative OpenWrt bootstrapper. It automates a
fresh installation or an in-place PARTY update only when one published package
exactly matches the running system.

## Recommended command

The canonical stable command downloads the complete script before executing
it. The `&&` boundary prevents a failed or partial download from reaching the
shell:

```sh
wget -qO /tmp/ssclash-party-install.sh https://github.com/ponkcore/SSClash-PARTY/releases/latest/download/ssclash-party-install.sh && sh /tmp/ssclash-party-install.sh install
```

This is one shell command, even though it deliberately keeps download and
execution as two ordered operations. Piping a network response directly into
`sh` is not the supported installation path.

Run only the read-only compatibility check with:

```sh
wget -qO /tmp/ssclash-party-install.sh https://github.com/ponkcore/SSClash-PARTY/releases/latest/download/ssclash-party-install.sh && sh /tmp/ssclash-party-install.sh doctor
```

The installer is interactive by default. Automation may add `--yes`, but an
unattended replacement of a compatible non-PARTY package also requires the
explicit `--allow-package-migration` acknowledgement.

## Local device inspection

The installer reads the following information locally and does not upload the
device inventory:

- OpenWrt release, target, and package architecture;
- board name and model;
- the native package manager (`apk` or `opkg`);
- firewall backend;
- total memory and free overlay and temporary storage;
- installed packages that are known to compete for transparent proxy, DNS, or
  firewall ownership;
- current PARTY and Mihomo state;
- durable Clash running and boot-enabled state for upgrade preservation.

Hardware model names alone never select a package. The selection key is the
exact tuple:

```text
OpenWrt release | target/subtarget | DISTRIB_ARCH | package format
```

An unknown tuple, inconsistent package-manager architecture, insufficient
resources, wrong firewall backend, duplicate manifest entry, or detected
proxy conflict stops the installer before a package index or persistent file
is changed.

## Verified manifest

Release manifests are line-oriented, pipe-delimited data and are never sourced
as shell code. They bind each supported system tuple to:

- one immutable PARTY release asset;
- its exact SHA-256 digest;
- resource requirements and firewall contract;
- a validation tier and optional live-tested boards;
- one pinned Mihomo architecture, version, compressed size, and SHA-256.

The installer first looks for the channel-specific
`ssclash-party-preview-manifest` or `ssclash-party-stable-manifest` asset. This
prevents a stable release from being mistaken for a preview, or the reverse.
The preview channel falls back to the checksum-protected catalog under
`installer/channels/` so the already published PARTY.3 release is installable
even though it predates release manifests.

Every future release workflow publishes:

- `ssclash-party-install.sh` and its checksum;
- its channel-specific manifest and checksum;
- each architecture-specific package and its checksum.

The package checksum must agree with both its adjacent release sidecar and the
manifest. The Mihomo archive must agree with the pinned manifest digest and
compressed size, and must pass gzip integrity and native execution tests.

## Safety behavior

The installer never:

- downloads or flashes an OpenWrt firmware image;
- guesses compatibility from `uname` alone;
- selects a package from another OpenWrt release or target;
- performs a blanket package upgrade;
- removes another proxy client;
- invents a fallback architecture;
- starts Clash with an unconfigured first-install profile;
- replaces an existing valid Mihomo core merely because a newer release
  exists.

Before an existing compatible installation is changed, a mode-0600 recovery
archive is written under `/tmp`. It contains only the relevant configuration,
managed links, active YAML, and a non-secret service-state record. The core is
installed only when missing or invalid. Its candidate binary and existing
configuration are tested before atomic activation.

The PARTY package lifecycle remains authoritative for upgrades. It preserves
the active profile and restores the pre-install Clash running and boot state.
On a first installation, both Clash and the subscription updater remain
stopped and disabled until the user configures PARTY through LuCI.

## Commands and options

```text
doctor     read-only compatibility and conflict check
check      read-only check ending with a machine-readable update record
install    fresh installation or safe in-place update
upgrade    update only when PARTY is already installed
```

Useful options:

```text
--yes                       skip final confirmation
--dry-run                   print the plan without mutation
--no-core                   leave Mihomo installation to the operator
--allow-package-migration   acknowledge unattended non-PARTY replacement
--channel stable|preview    choose the release channel (default: stable)
```

The stable channel resolves only GitHub's latest non-prerelease and requires a
`ssclash-party-stable-manifest` asset. A newer installed PARTY version is never
silently downgraded to an older stable or preview channel.

## LuCI updater

**Services → SSClash → Settings → Software Updates → PARTY** invokes a constrained
router-local helper. It exposes only `status`, `check`, and `start` operations,
always selects the stable channel, and delegates exact device matching and
checksum verification to the packaged installer.

The update runs detached because installing LuCI may restart `rpcd` and the
web service. A lock prevents concurrent updates. The UI receives only a fixed,
non-secret state record; full installer and package-manager output is retained
in a mode-0600 file below `/tmp/ssclash-party-update/` and is never returned to
the browser. Package lifecycle hooks restore the prior service state, while
the installer creates its ordinary recovery archive before mutation.

## Maintainer release contract

`scripts/build-installer-manifest.sh` validates all package checksum sidecars,
requires the release tag to match the embedded PARTY version, and emits the
manifest plus its checksum. The GitHub Actions release job adds the installer,
manifest, and their sidecars to the ordinary package assets.

`tests/installer/test-installer.sh` covers exact ARM64 and x86 matches,
unsupported targets, wrong package managers, proxy conflicts, corrupted and
duplicate manifests, dry runs, same-version no-op behavior, downgrade
prevention, and release manifest generation. `tests/updater/test-updater.sh`
covers update discovery, background completion, private logs, no-op status,
ahead-of-channel protection, and redacted failures.
