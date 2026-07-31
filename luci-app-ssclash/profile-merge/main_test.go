package main

import (
	"encoding/hex"
	"testing"
)

func validCurrent() map[string]any {
	return map[string]any{
		"tproxy-port":         7894,
		"external-controller": "192.168.10.1:9090",
		"secret":              "test-controller-secret",
		"log-level":           "error",
		"dns": map[string]any{
			"enable": true,
			"listen": "127.0.0.1:7874",
		},
	}
}

func validRemote() map[string]any {
	return map[string]any{
		"mixed-port":               7890,
		"ipv6":                     true,
		"external-controller-unix": "/tmp/unsafe.sock",
		"external-doh-server":      "/dns-query",
		"tun": map[string]any{
			"enable": true,
		},
		"dns": map[string]any{
			"enable":        true,
			"enhanced-mode": "fake-ip",
			"fake-ip-range": "198.18.0.1/16",
		},
		"proxies": []any{
			map[string]any{"name": "node-1", "type": "vless"},
		},
		"proxy-groups": []any{
			map[string]any{
				"name":        "PROXY",
				"type":        "select",
				"include-all": true,
			},
		},
		"rules": []any{"MATCH,PROXY"},
	}
}

func defaultPolicy() routerPolicy {
	return routerPolicy{DNSMode: "preserve"}
}

func TestOverlayRouterSettings(t *testing.T) {
	merged, normalized, _, generatedSecret, err := overlayRouterSettings(
		validRemote(),
		validCurrent(),
		defaultPolicy(),
	)
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	if generatedSecret {
		t.Fatal("existing controller secret must be retained")
	}
	if len(normalized) != 0 {
		t.Fatalf("unexpected provider normalization: %v", normalized)
	}
	for _, key := range []string{
		"tun",
		"mixed-port",
		"external-controller-unix",
		"external-doh-server",
	} {
		if _, exists := merged[key]; exists {
			t.Fatalf("%s must be removed", key)
		}
	}
	if merged["tproxy-port"] != 7894 {
		t.Fatalf("unexpected tproxy-port: %v", merged["tproxy-port"])
	}
	if merged["routing-mark"] != 2 {
		t.Fatalf("unexpected routing mark: %v", merged["routing-mark"])
	}
	if merged["ipv6"] != false {
		t.Fatalf("IPv6 was not disabled: %v", merged["ipv6"])
	}
	if merged["find-process-mode"] != "off" {
		t.Fatalf("process matching must be disabled on the router: %v", merged["find-process-mode"])
	}
	if merged["secret"] != "test-controller-secret" {
		t.Fatal("controller secret was not preserved")
	}
	dns := asMap(merged["dns"])
	if dns["listen"] != "127.0.0.1:7874" {
		t.Fatalf("unexpected DNS listener: %v", dns["listen"])
	}
	if _, exists := dns["enhanced-mode"]; exists {
		t.Fatalf("remote DNS interception mode must not replace the router mode: %v", dns["enhanced-mode"])
	}
	if _, exists := dns["fake-ip-range"]; exists {
		t.Fatalf("remote fake-IP range must not replace the router mode: %v", dns["fake-ip-range"])
	}
}

func TestProviderGroupNormalization(t *testing.T) {
	remote := validRemote()
	remote["proxy-providers"] = map[string]any{
		"provider1": map[string]any{"type": "http", "url": "https://example.invalid/sub"},
	}

	merged, normalized, _, _, err := overlayRouterSettings(remote, validCurrent(), defaultPolicy())
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	if len(normalized) != 1 || normalized[0] != "PROXY" {
		t.Fatalf("unexpected normalized groups: %v", normalized)
	}
	group := asMap(asSlice(merged["proxy-groups"])[0])
	if _, exists := group["include-all"]; exists {
		t.Fatal("include-all must be removed when providers are present")
	}
	use := stringSlice(group["use"])
	if len(use) != 1 || use[0] != "provider1" {
		t.Fatalf("unexpected provider use list: %v", use)
	}
	if group["include-all-proxies"] != true {
		t.Fatalf("inline proxies were not retained: %v", group["include-all-proxies"])
	}
	provider := asMap(asMap(merged["proxy-providers"])["provider1"])
	if provider["path"] != "./managed-providers/proxies/afa22653fd32b8b6.yaml" {
		t.Fatalf("unexpected managed provider path: %v", provider["path"])
	}
}

func TestRuleProviderCacheNormalization(t *testing.T) {
	remote := validRemote()
	remote["rule-providers"] = map[string]any{
		"youtube": map[string]any{
			"type":   "http",
			"format": "mrs",
			"path":   "/etc/config/unsafe",
			"url":    "https://example.invalid/youtube.mrs",
		},
	}

	merged, _, _, _, err := overlayRouterSettings(remote, validCurrent(), defaultPolicy())
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	provider := asMap(asMap(merged["rule-providers"])["youtube"])
	if provider["path"] != "./managed-providers/rules/c63770519da94528.mrs" {
		t.Fatalf("unexpected managed rule-provider path: %v", provider["path"])
	}
}

func TestRejectsRemoteFileProvider(t *testing.T) {
	remote := validRemote()
	remote["rule-providers"] = map[string]any{
		"local": map[string]any{
			"type": "file",
			"path": "./ruleset/local.yaml",
		},
	}

	_, _, _, _, err := overlayRouterSettings(remote, validCurrent(), defaultPolicy())
	if err == nil {
		t.Fatal("remote file provider must be rejected")
	}
}

func TestRejectsMissingPolicy(t *testing.T) {
	_, _, _, _, err := overlayRouterSettings(map[string]any{}, validCurrent(), defaultPolicy())
	if err == nil {
		t.Fatal("empty remote profile must be rejected")
	}
}

func TestGeneratesMissingControllerSecret(t *testing.T) {
	current := validCurrent()
	delete(current, "secret")
	merged, _, _, generatedSecret, err := overlayRouterSettings(validRemote(), current, defaultPolicy())
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	if !generatedSecret {
		t.Fatal("missing controller secret was not generated")
	}
	secret, ok := merged["secret"].(string)
	if !ok || len(secret) != 64 {
		t.Fatalf("unexpected generated secret: %T, length %d", merged["secret"], len(secret))
	}
	if _, err := hex.DecodeString(secret); err != nil {
		t.Fatalf("generated secret is not hexadecimal: %v", err)
	}
}

func TestReplacesControllerSecretThatCannotBeParsedSafely(t *testing.T) {
	current := validCurrent()
	current["secret"] = "unsafe secret: # not suitable for a YAML scalar reader"
	merged, _, _, generatedSecret, err := overlayRouterSettings(validRemote(), current, defaultPolicy())
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	if !generatedSecret {
		t.Fatal("an unsafe controller secret must be replaced")
	}
	if !safeControllerSecret(nonEmptyString(merged["secret"])) {
		t.Fatal("replacement controller secret is not safe")
	}
}

func TestControllerOverrideReplacesWildcard(t *testing.T) {
	current := validCurrent()
	current["external-controller"] = "0.0.0.0:9090"
	policy := defaultPolicy()
	policy.Controller = "192.168.50.1:9090"

	merged, _, _, _, err := overlayRouterSettings(validRemote(), current, policy)
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	if merged["external-controller"] != "192.168.50.1:9090" {
		t.Fatalf("unexpected controller: %v", merged["external-controller"])
	}
}

func TestRejectsUnsafeController(t *testing.T) {
	for _, controller := range []string{
		"0.0.0.0:9090",
		"203.0.113.1:9090",
		"router.example:9090",
	} {
		policy := defaultPolicy()
		policy.Controller = controller
		if _, _, _, _, err := overlayRouterSettings(validRemote(), validCurrent(), policy); err == nil {
			t.Fatalf("unsafe controller %q must be rejected", controller)
		}
	}
}

func TestPreservesTestedFakeIPBaseline(t *testing.T) {
	current := validCurrent()
	current["dns"] = map[string]any{
		"enable":              true,
		"listen":              "127.0.0.1:7874",
		"enhanced-mode":       "fake-ip",
		"fake-ip-range":       "198.18.0.1/16",
		"fake-ip-filter-mode": "blacklist",
		"fake-ip-filter":      []any{"+.lan", "+.local"},
	}
	policy := defaultPolicy()
	policy.DNSMode = "fake-ip"

	merged, _, _, _, err := overlayRouterSettings(validRemote(), current, policy)
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	dns := asMap(merged["dns"])
	if dns["enhanced-mode"] != "fake-ip" || dns["fake-ip-range"] != "198.18.0.1/16" {
		t.Fatalf("fake-ip baseline was not preserved: %#v", dns)
	}
}

func TestRefusesUntestedFakeIPMigration(t *testing.T) {
	policy := defaultPolicy()
	policy.DNSMode = "fake-ip"
	if _, _, _, _, err := overlayRouterSettings(validRemote(), validCurrent(), policy); err == nil {
		t.Fatal("fake-ip must require an existing tested baseline")
	}
}

func TestPreservesLocalFakeIPCachePolicy(t *testing.T) {
	current := validCurrent()
	current["profile"] = map[string]any{
		"store-fake-ip": true,
	}
	remote := validRemote()
	remote["profile"] = map[string]any{
		"store-selected": true,
		"store-fake-ip":  false,
	}

	merged, _, _, _, err := overlayRouterSettings(remote, current, defaultPolicy())
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	profile := asMap(merged["profile"])
	if profile["store-selected"] != true {
		t.Fatalf("safe remote profile setting was lost: %#v", profile)
	}
	if profile["store-fake-ip"] != true {
		t.Fatalf("local fake-IP cache policy was not preserved: %#v", profile)
	}
}

func TestRuntimeRestartDetection(t *testing.T) {
	current := validCurrent()
	current["allow-lan"] = false
	current["find-process-mode"] = "off"
	current["ipv6"] = false
	current["routing-mark"] = 2

	merged, _, _, _, err := overlayRouterSettings(validRemote(), current, defaultPolicy())
	if err != nil {
		t.Fatalf("overlay failed: %v", err)
	}
	if runtimeRestartRequired(current, merged) {
		t.Fatal("an unchanged protected runtime must remain eligible for hot reload")
	}

	current["secret"] = "different-controller-secret"
	if !runtimeRestartRequired(current, merged) {
		t.Fatal("a controller secret change must require a guarded restart")
	}
}
