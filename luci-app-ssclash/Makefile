# Copyright 2024-2026 ZeroChaos (https://github.com/zerolabnet/SSClash)
# This is free software, licensed under the GNU General Public License v2.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ssclash
PKG_VERSION:=4.7.0
PKG_RELEASE:=7
PKG_MAINTAINER:=ZeroChaos <dev@null.la>, ponkcore
PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_URL:=https://github.com/ponkcore/SSClash-PARTY

LUCI_TITLE:=LuCI Support for SSClash PARTY
LUCI_DEPENDS:= \
	+luci-base \
	+coreutils-base64 \
	+kmod-tun \
	+curl \
	+jsonfilter \
	+PACKAGE_$(PKG_NAME)_Iptables_Transparent_Proxy:iptables-mod-tproxy \
	+PACKAGE_$(PKG_NAME)_Nftables_Transparent_Proxy:kmod-nft-tproxy

PKG_CONFIG_DEPENDS:= \
	CONFIG_PACKAGE_$(PKG_NAME)_Iptables_Transparent_Proxy \
	CONFIG_PACKAGE_$(PKG_NAME)_Nftables_Transparent_Proxy

PKG_BUILD_DEPENDS:=luci-base/host golang/host
PKG_BUILD_PARALLEL:=1

GO_PKG:=github.com/zerolabnet/SSClash/luci-app-ssclash/profile-merge
GO_PKG_BUILD_PKG:=$(GO_PKG)
GO_PKG_INSTALL_EXTRA:=vendor/modules.txt

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

# The OpenWrt Go helper stages local package sources below GOPATH. Explicitly
# use GOPATH mode for this vendored, in-tree command so `go list` does not try
# to discover a module or VCS repository from the SDK's parent directory.
GO_PKG_BUILD_VARS += GO111MODULE=off
GO_MOD_ARGS:=

define Package/$(PKG_NAME)
	SECTION:=luci
	CATEGORY:=LuCI
	SUBMENU:=3. Applications
	TITLE:=$(LUCI_TITLE)
	DEPENDS:=$(GO_ARCH_DEPENDS) $(LUCI_DEPENDS)
endef

define Package/$(PKG_NAME)/config
choice
	prompt "Transparent Proxy Backend for SSClash"
	default PACKAGE_$(PKG_NAME)_Iptables_Transparent_Proxy if !PACKAGE_firewall4
	default PACKAGE_$(PKG_NAME)_Nftables_Transparent_Proxy if PACKAGE_firewall4

config PACKAGE_$(PKG_NAME)_Iptables_Transparent_Proxy
	bool "Iptables Transparent Proxy"
	select PACKAGE_iptables-mod-tproxy

config PACKAGE_$(PKG_NAME)_Nftables_Transparent_Proxy
	bool "Nftables Transparent Proxy"
	select PACKAGE_kmod-nft-tproxy

endchoice
endef

define Package/$(PKG_NAME)/description
	LuCI interface for SSClash PARTY, including adaptive subscriptions,
	proxy-link templates, manual YAML, and transactional Mihomo activation.
endef

define Build/Prepare
	rm -rf $(PKG_BUILD_DIR)
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
	$(CP) ./profile-merge/. $(PKG_BUILD_DIR)/
	$(CP) ../LICENSE $(PKG_BUILD_DIR)/
endef

define Build/Compile
	$(call GoPackage/Build/Compile)

	@mkdir -p $(PKG_BUILD_DIR)/po/ru
	@if [ -f "./rootfs/po/ru/ssclash.po" ]; then \
		$(STAGING_DIR_HOSTPKG)/bin/po2lmo \
			"./rootfs/po/ru/ssclash.po" \
			"$(PKG_BUILD_DIR)/po/ru/ssclash.lmo"; \
	fi
	@mkdir -p $(PKG_BUILD_DIR)/po/zh-cn
	@if [ -f "./rootfs/po/zh-cn/ssclash.po" ]; then \
		$(STAGING_DIR_HOSTPKG)/bin/po2lmo \
			"./rootfs/po/zh-cn/ssclash.po" \
			"$(PKG_BUILD_DIR)/po/zh-cn/ssclash.lmo"; \
	fi
endef

define Package/$(PKG_NAME)/conffiles
/opt/clash/config.yaml
/etc/config/ssclash_profile
/etc/ssclash-party/links.txt
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./rootfs/etc/init.d/clash $(1)/etc/init.d/
	$(INSTALL_BIN) ./rootfs/etc/init.d/ssclash-profile-sync $(1)/etc/init.d/

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./rootfs/etc/config/ssclash_profile $(1)/etc/config/
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./rootfs/etc/uci-defaults/99-ssclash-party $(1)/etc/uci-defaults/
	$(INSTALL_DIR) $(1)/etc/ssclash-party
	$(INSTALL_CONF) ./rootfs/etc/ssclash-party/links.txt $(1)/etc/ssclash-party/

	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(GO_PKG_BUILD_BIN_DIR)/profile-merge $(1)/usr/bin/ssclash-profile-merge

	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) ./rootfs/usr/libexec/ssclash-profile-sync $(1)/usr/libexec/
	$(INSTALL_BIN) ./rootfs/usr/libexec/ssclash-party-migrate $(1)/usr/libexec/
	$(INSTALL_BIN) ./rootfs/usr/libexec/ssclash-party-panel $(1)/usr/libexec/
	$(INSTALL_BIN) ./rootfs/usr/libexec/ssclash-router-integration $(1)/usr/libexec/

	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface
	$(INSTALL_BIN) ./rootfs/etc/hotplug.d/iface/40-clash $(1)/etc/hotplug.d/iface/
	$(INSTALL_DIR) $(1)/etc/hotplug.d/net
	$(INSTALL_BIN) ./rootfs/etc/hotplug.d/net/99-clash-tun $(1)/etc/hotplug.d/net/

	$(INSTALL_DIR) $(1)/opt/clash/bin
	$(INSTALL_BIN) ./rootfs/opt/clash/bin/clash-rules $(1)/opt/clash/bin/

	$(INSTALL_DIR) $(1)/opt/clash
	$(INSTALL_CONF) ./rootfs/opt/clash/config.yaml $(1)/opt/clash/
	$(INSTALL_DIR) $(1)/opt/clash/managed-sources
	$(INSTALL_DIR) $(1)/opt/clash/profile-cache

	$(INSTALL_DIR) $(1)/opt/clash/ui
	$(CP) ./rootfs/opt/clash/ui/* $(1)/opt/clash/ui/

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./rootfs/usr/share/luci/menu.d/luci-app-ssclash.json $(1)/usr/share/luci/menu.d/

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./rootfs/usr/share/rpcd/acl.d/luci-app-ssclash.json $(1)/usr/share/rpcd/acl.d/

	$(INSTALL_DIR) $(1)/usr/share/ssclash-party/templates
	$(INSTALL_DATA) ./rootfs/usr/share/ssclash-party/VERSION $(1)/usr/share/ssclash-party/
	$(INSTALL_DATA) ./rootfs/usr/share/ssclash-party/templates/catalog.json $(1)/usr/share/ssclash-party/templates/
	$(INSTALL_CONF) ./rootfs/usr/share/ssclash-party/templates/russia.yaml $(1)/usr/share/ssclash-party/templates/

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/ssclash
	$(CP) ./rootfs/www/luci-static/resources/view/ssclash/* $(1)/www/luci-static/resources/view/ssclash/
	$(INSTALL_DATA) ./rootfs/www/ssclash-party-index.html $(1)/www/
	$(INSTALL_DATA) ./rootfs/www/ssclash-party-host.js $(1)/www/
	ln -s /opt/clash/ui $(1)/www/party-dashboard

	$(INSTALL_DIR) $(1)/opt/clash/lst

ifdef CONFIG_USE_APK
	$(INSTALL_DIR) $(1)/etc/apk/protected_paths.d
	$(INSTALL_DATA) ./rootfs/etc/apk/protected_paths.d/ssclash.list $(1)/etc/apk/protected_paths.d/
endif

	@if [ -f "$(PKG_BUILD_DIR)/po/ru/ssclash.lmo" ]; then \
		$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n; \
		$(INSTALL_DATA) "$(PKG_BUILD_DIR)/po/ru/ssclash.lmo" \
			"$(1)/usr/lib/lua/luci/i18n/ssclash.ru.lmo"; \
	fi
	@if [ -f "$(PKG_BUILD_DIR)/po/zh-cn/ssclash.lmo" ]; then \
		$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n; \
		$(INSTALL_DATA) "$(PKG_BUILD_DIR)/po/zh-cn/ssclash.lmo" \
			"$(1)/usr/lib/lua/luci/i18n/ssclash.zh-cn.lmo"; \
	fi
endef

define Package/$(PKG_NAME)/preinst
#!/bin/sh
mkdir -p /opt/clash 2>/dev/null || true
HAD_CONFIG=0
PREVIOUS_PARTY_VERSION=unknown
if [ -f /opt/clash/config.yaml ]; then
	cp -p /opt/clash/config.yaml /opt/clash/.config.yaml.upgrade.bak
	HAD_CONFIG=1
fi
if [ -f /usr/share/ssclash-party/VERSION ]; then
	detected_version="$$(sed -n '1p' /usr/share/ssclash-party/VERSION)"
	case "$$detected_version" in
		4.7.0-party.1|4.7.0-party.2|4.7.0-party.3|4.7.0-party.4|4.7.0-party.5)
			PREVIOUS_PARTY_VERSION="$$detected_version"
			;;
	esac
fi
[ -n "$$IPKG_INSTROOT" ] || {
	STATE=/tmp/ssclash-party-upgrade.state
	CLASH_ENABLED=0
	CLASH_RUNNING=0
	/etc/init.d/clash enabled >/dev/null 2>&1 && CLASH_ENABLED=1
	/etc/init.d/clash status >/dev/null 2>&1 && CLASH_RUNNING=1
	umask 077
	{
		echo "HAD_CONFIG=$$HAD_CONFIG"
		echo "PREVIOUS_PARTY_VERSION=$$PREVIOUS_PARTY_VERSION"
		echo "CLASH_ENABLED=$$CLASH_ENABLED"
		echo "CLASH_RUNNING=$$CLASH_RUNNING"
	} > "$$STATE"
}
exit 0
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
STATE=/tmp/ssclash-party-upgrade.state
FIRST_INSTALL=1
if [ "$${PKG_UPGRADE:-0}" = "1" ] || \
	grep -qx 'HAD_CONFIG=1' "$$STATE" 2>/dev/null; then
	FIRST_INSTALL=0
fi
if [ -f /opt/clash/.config.yaml.upgrade.bak ]; then
	mv /opt/clash/.config.yaml.upgrade.bak /opt/clash/config.yaml
fi
[ -n "$$IPKG_INSTROOT" ] || {
	/etc/init.d/rpcd reload
	rm -f /tmp/luci-*
	chmod 600 /etc/config/ssclash_profile 2>/dev/null || true
	chmod 600 /opt/clash/config.yaml 2>/dev/null || true
	mkdir -p /etc/ssclash-party /opt/clash/managed-sources /opt/clash/profile-cache
	chmod 700 /etc/ssclash-party /opt/clash/managed-sources /opt/clash/profile-cache 2>/dev/null || true
	[ -f /etc/ssclash-party/links.txt ] || : > /etc/ssclash-party/links.txt
	chmod 600 /etc/ssclash-party/links.txt 2>/dev/null || true

	/usr/libexec/ssclash-party-migrate || exit 1
	rm -f /etc/config/ssclash_profile.apk-new
	if /usr/libexec/ssclash-party-panel apply >/dev/null 2>&1; then
		rm -f /etc/uci-defaults/99-ssclash-party
	fi

	# On first install the default config.yaml is just a usable example
	# (no real proxies configured). Prevent auto-start on next boot so the
	# user can edit /opt/clash/config.yaml first. "Start Service" in LuCI
	# re-enables it via `/etc/init.d/clash enable`.
	if [ "$$FIRST_INSTALL" = "1" ]; then
		/etc/init.d/clash stop 2>/dev/null || true
		/etc/init.d/clash disable 2>/dev/null || true
		/etc/init.d/ssclash-profile-sync stop 2>/dev/null || true
		/etc/init.d/ssclash-profile-sync disable 2>/dev/null || true
	fi

	# Ensure periodic clash-rules update cron job exists
	CRON_FILE="/etc/crontabs/root"
	CRON_LINE="*/30 * * * * /opt/clash/bin/clash-rules update >/dev/null 2>&1"

	[ -f "$$CRON_FILE" ] || touch "$$CRON_FILE"
	if ! grep -Fq "/opt/clash/bin/clash-rules update" "$$CRON_FILE" 2>/dev/null; then
		echo "$$CRON_LINE" >> "$$CRON_FILE"
		/etc/init.d/cron restart >/dev/null 2>&1 || true
	fi

	if [ "$$FIRST_INSTALL" = "0" ]; then
		CLASH_SHOULD_ENABLE=0
		CLASH_SHOULD_RUN=0
		LEGACY_LIFECYCLE_RECOVERY=0
		if [ -s "$$STATE" ]; then
			grep -qx 'CLASH_ENABLED=1' "$$STATE" && CLASH_SHOULD_ENABLE=1
			grep -qx 'CLASH_RUNNING=1' "$$STATE" && CLASH_SHOULD_RUN=1
			grep -Eq '^PREVIOUS_PARTY_VERSION=4\.7\.0-party\.[12]$$' "$$STATE" && \
				LEGACY_LIFECYCLE_RECOVERY=1
		fi

		# OpenWrt's generated APK pre-deinstall hook stops packaged services
		# before the new pre-upgrade script can inspect their runtime state.
		# An enabled service is therefore the durable indication that it must
		# resume. PARTY.1 and PARTY.2 could lose that link during an upgrade,
		# so their managed-subscription state is a one-time recovery fallback.
		if [ "$$CLASH_SHOULD_ENABLE" = "1" ]; then
			CLASH_SHOULD_RUN=1
		fi
		ACTIVE_PROFILE="$$(uci -q get ssclash_profile.main.active_profile)"
		if [ "$$LEGACY_LIFECYCLE_RECOVERY" = "1" ] && \
			[ "$$(uci -q get ssclash_profile.main.source_mode)" = "subscription" ] && \
			[ "$$(uci -q get ssclash_profile.$$ACTIVE_PROFILE.enabled)" = "1" ] && \
			[ -n "$$(uci -q get ssclash_profile.$$ACTIVE_PROFILE.url)" ]; then
			CLASH_SHOULD_ENABLE=1
			CLASH_SHOULD_RUN=1
		fi

		if [ "$$CLASH_SHOULD_ENABLE" = "1" ]; then
			/etc/init.d/clash enable 2>/dev/null || true
		else
			/etc/init.d/clash disable 2>/dev/null || true
		fi
		if [ "$$CLASH_SHOULD_RUN" = "1" ]; then
			/etc/init.d/clash start 2>/dev/null || true
		else
			/etc/init.d/clash stop 2>/dev/null || true
		fi

		if [ "$$(uci -q get ssclash_profile.main.source_mode)" = "subscription" ] && \
			[ "$$(uci -q get ssclash_profile.$$ACTIVE_PROFILE.enabled)" = "1" ] && \
			[ -n "$$(uci -q get ssclash_profile.$$ACTIVE_PROFILE.url)" ]; then
			/etc/init.d/ssclash-profile-sync enable 2>/dev/null || true
			/etc/init.d/ssclash-profile-sync start 2>/dev/null || true
		else
			/etc/init.d/ssclash-profile-sync stop 2>/dev/null || true
			/etc/init.d/ssclash-profile-sync disable 2>/dev/null || true
		fi
	fi
	rm -f /tmp/ssclash-party-upgrade.state
}
exit 0
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] || {
	if [ "$${PKG_UPGRADE:-0}" != "1" ]; then
		/usr/libexec/ssclash-party-panel remove >/dev/null 2>&1 || true
		/etc/init.d/ssclash-profile-sync stop 2>/dev/null || true
		/etc/init.d/ssclash-profile-sync disable 2>/dev/null || true
	fi
}
exit 0
endef

define Package/$(PKG_NAME)/postrm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] || {
	if [ "$${PKG_UPGRADE:-0}" = "1" ]; then
		exit 0
	fi

	# Clean up cron job for clash-rules update, if present
	CRON_FILE="/etc/crontabs/root"
	if [ -f "$$CRON_FILE" ]; then
		sed -i '\|/opt/clash/bin/clash-rules update|d' "$$CRON_FILE" 2>/dev/null || true
		/etc/init.d/cron restart >/dev/null 2>&1 || true
	fi

	rm -rf /opt/clash/ui
	rm -f /opt/clash/ruleset
	rm -f /opt/clash/.dns_backup
	rm -rf /tmp/clash
	rm -rf /www/luci-static/resources/view/ssclash
	rm -f /www/ssclash-party-index.html /www/ssclash-party-host.js
	rm -f /usr/lib/lua/luci/i18n/ssclash.*.lmo
	rm -f /opt/clash/.config.yaml.upgrade.bak
	rm -f /etc/hotplug.d/iface/40-clash
	rm -f /etc/hotplug.d/net/99-clash-tun
	rm -f /etc/uci-defaults/99-ssclash-party
	rm -f /etc/apk/protected_paths.d/ssclash.list
	rm -rf /tmp/ssclash-profile-sync
	rm -rf /tmp/ssclash-profile-sync.lock
}
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
