# SSClash PARTY

> [!IMPORTANT]
> SSClash PARTY is an independent downstream of
> [zerolabnet/SSClash](https://github.com/zerolabnet/SSClash). It is not an
> official ZeroChaos release. The downstream keeps the upstream package name
> for safe upgrades and adds transactional configuration sources.

Project notes:

- [PARTY downstream policy](PARTY.md)
- [Configuration sources](docs/configuration-sources.md)
- [Managed full-profile subscriptions](docs/managed-full-profile.md)
- [Upstream synchronization](docs/upstream-sync.md)

<p align="center">
 <img src=".github/assets/images/logos/SSClash.png" width="200">
</p>

<h3 align="center">SSClash with guarded subscriptions, proxy-link templates, and manual Mihomo YAML for OpenWrt</h3>

# Setup Guide

## Configuration sources

The Configuration page supports three source modes:

- an adaptive HTTPS subscription that accepts complete Mihomo YAML,
  nodes-only YAML, plaintext proxy URIs, or Base64 URI lists;
- any number of local VLESS, Shadowsocks, Hysteria2, Trojan, VMess, and other
  Mihomo-compatible share links combined with a PARTY routing template;
- a complete manually maintained YAML, matching the original SSClash editor
  workflow.

Subscription users can preserve a complete provider policy or force the
selected PARTY template. The initial template is **Russia**; more catalog
entries can be added without changing the source workflow. Router-critical
TProxy, DNS, and controller settings remain protected locally in both managed
modes.

Candidates are parsed, tested with Mihomo, installed atomically, and
hot-reloaded with post-apply health checks and automatic rollback. See
[Configuration sources](docs/configuration-sources.md) for the complete user
and compatibility contract, and
[Managed full-profile subscriptions](docs/managed-full-profile.md) for the
trust boundary, LuCI workflow, fake-IP policy, recovery procedure, and
architecture-specific package requirements.

# Installation

Do not run the upstream SSClash autoinstall script over a PARTY installation:
it installs upstream release packages and can replace downstream files.

Use a checksum-verified PARTY release artifact that exactly matches the
OpenWrt release and package architecture. PARTY packages are
architecture-specific because they include a compiled structural YAML merger.

# Manual install

## Step 1: Update Package List

Update the package list to ensure you have the latest available versions.

For **OpenWrt >= 25** (apk):

```bash
apk update
```

For **OpenWrt < 25** (opkg):

```bash
opkg update
```

## Step 2: Install Required Packages

In general, package managers resolve dependencies automatically when you install from a package repository. In this guide, we use manual installation from GitHub Releases, and required dependencies are:

- `coreutils-base64` – for scripts that use Base64;
- `kmod-tun` – for TUN mode;
- the appropriate transparent proxy module depending on your firewall stack:
  - `kmod-nft-tproxy` for **firewall4 / nftables**;
  - `iptables-mod-tproxy` for **firewall3 / iptables**.

Only if you are installing packages manually (`.apk`/`.ipk`) or building a custom image and dependencies are missing, you can install the transparent proxy modules manually:

```bash
# For nftables (firewall4) on OpenWrt >= 25:
apk add kmod-nft-tproxy

# For nftables (firewall4) on older OpenWrt:
opkg install kmod-nft-tproxy

# For iptables (firewall3, OpenWrt < 22.03.x):
opkg install iptables-mod-tproxy
```

## Step 3: Download and Install `luci-app-ssclash` Package

Download the exact PARTY package from the
[release page](https://github.com/ponkcore/SSClash-PARTY/releases), along with
its adjacent `.sha256` file.

Current PARTY preview releases provide packages for:

- OpenWrt 25.12.5 `mediatek/filogic`, `aarch64_cortex-a53`, including the
  Cudy WBR3000UAX v1;
- OpenWrt 25.12.5 `x86/64`, `x86_64`;
- OpenWrt 24.10.8 `x86/64`, `x86_64`.

For the Cudy WBR3000UAX v1 on OpenWrt 25.12.5:

```sh
release_url='https://github.com/ponkcore/SSClash-PARTY/releases/download/v4.7.0-party.2'
artifact='luci-app-ssclash-4.7.0-r3-openwrt-25.12.5-mediatek-filogic-aarch64_cortex-a53.apk'

curl -fL "$release_url/$artifact" -o "/tmp/$artifact"
curl -fL "$release_url/$artifact.sha256" -o "/tmp/$artifact.sha256"
(cd /tmp && sha256sum -c "$artifact.sha256")
apk add --allow-untrusted "/tmp/$artifact"
```

## Step 4: Automatic Mihomo Kernel Management

Go to **Settings** → **Mihomo Kernel Management** and click **Download Latest Kernel**. The system will:

- Automatically detect your router's architecture
- Download the latest compatible Mihomo kernel
- Install and configure it properly
- Show kernel status and version information

**Important:** Restart the Clash service after kernel installation.

### Manual Kernel Installation (Optional)

If you prefer manual installation, navigate to the `bin` directory and download the Clash.Meta Kernel:

```bash
cd /opt/clash/bin
```

For **amd64** architecture:

```bash
curl -L https://github.com/MetaCubeX/mihomo/releases/download/v1.19.27/mihomo-linux-amd64-compatible-v1.19.27.gz -o clash.gz
```

For **arm64** architecture:

```bash
curl -L https://github.com/MetaCubeX/mihomo/releases/download/v1.19.27/mihomo-linux-arm64-v1.19.27.gz -o clash.gz
```

For **mipsel_24kc** architecture:

```bash
curl -L https://github.com/MetaCubeX/mihomo/releases/download/v1.19.27/mihomo-linux-mipsle-softfloat-v1.19.27.gz -o clash.gz
```

Need a different architecture? Visit the [MetaCubeX Release Page](https://github.com/MetaCubeX/mihomo/releases) and choose the one that matches your device.

Decompress and make executable:

```bash
gunzip clash.gz
chmod +x clash
```

## Step 5: Configure Interface Processing Mode

SSClash offers two interface processing modes:

### Exclude Mode (Universal approach) - **Recommended for most users**

- **Default mode** that processes traffic from ALL interfaces except selected ones
- Automatically detects and excludes WAN interface
- Simple to configure - just select interfaces to bypass proxy
- Best for typical home router setups

### Explicit Mode (Precise control) - **For advanced users**

- Processes traffic ONLY from selected interfaces
- More secure but requires manual configuration
- Automatically detects LAN bridge when enabled
- Ideal for complex network setups requiring precise control

### Additional Settings:

- **Block QUIC traffic**: Blocks UDP port 443 to improve proxy effectiveness for services like YouTube
- **Store rules and proxy providers in RAM**: rulesets and proxy-providers directories are placed on tmpfs to extend the lifespan of the NAND chip
- **Add HWID headers to subscriptions**: Automatically adds HWID headers to proxy-providers (Remnawave compatibility)

<p align="center">
 <img src=".github/assets/images/screenshots/scr-01.png" width="100%">
</p>

## Step 6: Clash Configuration Management

Edit your Clash configuration with the built-in editor featuring:

- **Syntax highlighting** for YAML files
- **Live service control** (Start/Stop/Restart)
- **Service status indicator**

<p align="center">
 <img src=".github/assets/images/screenshots/scr-02.png" width="100%">
</p>

## Step 7: Local Rulesets Management

Create and manage local rule files for use with `rule-providers`:

- **Create custom rule lists** with validation
- **Organized file management** with collapsible sections

<p align="center">
 <img src=".github/assets/images/screenshots/scr-03.png" width="100%">
</p>

## Step 8: Real-time Log Monitoring

Monitor Clash activity with the integrated log viewer:

- **Real-time log streaming** with automatic updates
- **Filtered display** showing only Clash-related entries
- **Color-coded log levels** and daemon identification
- **Auto-scroll** to latest entries

<p align="center">
 <img src=".github/assets/images/screenshots/scr-04.png" width="100%">
</p>

## Step 9: Dashboard Access

Access the Clash dashboard directly from the LuCI interface with automatic configuration detection.

<p align="center">
 <img src=".github/assets/images/screenshots/scr-05.png" width="100%">
</p>

# Remove Clash

To remove Clash completely:

```bash
# OpenWrt >= 25:
apk del luci-app-ssclash

# OpenWrt < 25:
opkg remove luci-app-ssclash

rm -rf /opt/clash
```
