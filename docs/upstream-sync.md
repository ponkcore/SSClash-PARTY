# Upstream synchronization

SSClash PARTY retains the full Git history of
[`zerolabnet/SSClash`](https://github.com/zerolabnet/SSClash). Renaming the
fork does not affect commit identity or the ability to merge new upstream
work.

## Remotes and branches

The expected remotes are:

```text
origin    https://github.com/ponkcore/SSClash-PARTY.git
upstream  https://github.com/zerolabnet/SSClash.git
```

The expected branches are:

```text
main                            clean upstream mirror
feature/managed-full-profile    reviewable feature implementation
party                           tested downstream release line
sync/upstream-YYYYMMDD          temporary integration branch
```

Disable pushes to the `upstream` remote locally. Only `origin` is a publication
target.

## Mirroring upstream

Fetch both repositories and require a fast-forward update of the mirror:

```sh
git fetch upstream
git fetch origin
git switch main
git merge --ff-only upstream/main
git push origin main
```

If `main` cannot fast-forward, stop. It contains an accidental downstream
commit or the remote was rewritten. Do not hide the problem with a force push
until the unexpected commits have been reviewed and preserved.

## Integrating upstream into PARTY

Create an integration branch from the current downstream release:

```sh
git switch party
git pull --ff-only origin party
git switch -c sync/upstream-YYYYMMDD
git merge main
```

Git automatically combines changes made in different files or non-overlapping
lines. When upstream and PARTY modify the same logic, Git stops at a conflict.
Resolve each conflict by understanding both behaviors; never choose all of one
side mechanically.

Pay particular attention to:

- `luci-app-ssclash/Makefile`;
- the LuCI configuration page and RPC ACL;
- `/etc/init.d/clash`;
- config persistence and package upgrade hooks;
- firewall, DNS, controller, and dashboard behavior;
- release workflow and version constants.

After resolving conflicts, run the complete local quality suite and build at
least the Cudy/OpenWrt 25 package. Push the integration branch and require the
full GitHub Actions matrix to pass.

Only then advance the release branch:

```sh
git switch party
git merge --ff-only sync/upstream-YYYYMMDD
git push origin party
```

Delete the temporary integration branch only after `party` is published and
the merge remains recoverable from its commit history.

## Invariants after every merge

Verify that:

- the package is still named `luci-app-ssclash`;
- PARTY branding does not erase upstream attribution;
- the full-profile URL remains protected in a mode-`0600` UCI file;
- remote YAML cannot replace protected listener, controller, TProxy, and DNS
  integration fields;
- remote file providers remain rejected and provider cache paths remain
  confined;
- candidates are structurally parsed and tested by Mihomo before activation;
- updates retain atomic install, authenticated reload, health checks, backup,
  and rollback;
- a stopped proxy is not started by the periodic updater;
- critical runtime changes use a guarded restart rather than a hot reload;
- packages remain architecture-specific and their metadata declares the
  correct dependencies;
- CI continues to scan for secrets and emits directly verifiable SHA-256
  sidecars.

## When upstream accepts a PARTY change

Do not retain two implementations indefinitely.

1. Mirror the upstream commit into `main`.
2. Integrate `main` into a temporary sync branch.
3. Remove the now-duplicate PARTY patch while preserving PARTY-only behavior.
4. Run the complete test and package matrix.
5. Merge the tested result into `party`.

This reduces the downstream conflict surface and lets future upstream fixes
apply naturally.

## Router updates are separate

Updating source branches does not update a router. The router changes only
when an explicitly selected, checksum-verified PARTY package is installed.
Never configure an unattended job to replace PARTY with the latest upstream
SSClash package.
