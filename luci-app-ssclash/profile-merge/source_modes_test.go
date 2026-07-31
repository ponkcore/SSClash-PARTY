package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestInspectCompleteAndNodesOnlyYAML(t *testing.T) {
	complete, err := yaml.Marshal(validRemote())
	if err != nil {
		t.Fatal(err)
	}
	inspection := inspectSourceBytes(complete)
	if inspection.Kind != "full" || inspection.InlineProxies != 1 || inspection.Groups != 1 {
		t.Fatalf("unexpected complete profile inspection: %#v", inspection)
	}

	nodes := validRemote()
	delete(nodes, "proxy-groups")
	delete(nodes, "rules")
	nodesBody, err := yaml.Marshal(nodes)
	if err != nil {
		t.Fatal(err)
	}
	inspection = inspectSourceBytes(nodesBody)
	if inspection.Kind != "nodes" || inspection.Reason != "nodes_only_yaml" {
		t.Fatalf("unexpected nodes-only inspection: %#v", inspection)
	}
}

func TestInspectPlainAndBase64ProxyLinks(t *testing.T) {
	plain := strings.Join([]string{
		"vless://00000000-0000-0000-0000-000000000000@example.invalid:443#one",
		"not-a-proxy-link",
		"ss://YWVzLTEyOC1nY206cGFzcw@example.invalid:443#two",
		"vless://00000000-0000-0000-0000-000000000000@example.invalid:443#one",
	}, "\n")
	inspection := inspectSourceBytes([]byte(plain))
	if inspection.Kind != "links" || inspection.LinkCount != 2 || inspection.SkippedLines != 1 {
		t.Fatalf("unexpected plain-link inspection: %#v", inspection)
	}
	if inspection.Encoding != "plain" {
		t.Fatalf("unexpected plain-link encoding: %s", inspection.Encoding)
	}

	encoded := base64.RawStdEncoding.EncodeToString([]byte(plain))
	inspection = inspectSourceBytes([]byte(encoded))
	if inspection.Kind != "links" || inspection.LinkCount != 2 || inspection.Encoding != "base64" {
		t.Fatalf("unexpected base64-link inspection: %#v", inspection)
	}
}

func TestInspectRejectsDiagnosticBodies(t *testing.T) {
	tests := []struct {
		body   string
		reason string
	}{
		{`{"outbounds":[]}`, "unsupported_json"},
		{`<!doctype html><title>error</title>`, "html_response"},
		{`subscription is unavailable`, "no_usable_proxies"},
	}
	for _, test := range tests {
		inspection := inspectSourceBytes([]byte(test.body))
		if inspection.Kind != "unsupported" || inspection.Reason != test.reason {
			t.Fatalf("unexpected inspection for %q: %#v", test.body, inspection)
		}
	}
}

func TestLocalManagedProviderIsNarrowlyAllowed(t *testing.T) {
	remote := validRemote()
	path := "./managed-sources/" + strings.Repeat("a", 64) + ".txt"
	remote["proxy-providers"] = map[string]any{
		localProviderName: map[string]any{
			"type": "file",
			"path": path,
		},
	}
	policy := defaultPolicy()
	policy.TrustedLocalProviderPath = path
	if _, _, _, _, err := overlayRouterSettings(remote, validCurrent(), policy); err != nil {
		t.Fatalf("trusted managed provider was rejected: %v", err)
	}

	asMap(remote["proxy-providers"])[localProviderName] = map[string]any{
		"type": "file",
		"path": "./managed-sources/not-a-hash.txt",
	}
	if _, _, _, _, err := overlayRouterSettings(remote, validCurrent(), policy); err == nil {
		t.Fatal("an untrusted local provider path must be rejected")
	}
}

func TestRussiaTemplateIsCredentialFreeAndComplete(t *testing.T) {
	path := filepath.Join("..", "rootfs", "usr", "share", "ssclash-party", "templates", "russia.yaml")
	document, body, err := readYAML(path)
	if err != nil {
		t.Fatalf("read Russia template: %v", err)
	}
	if err := validateTemplate(document); err != nil {
		t.Fatalf("validate Russia template: %v", err)
	}
	if len(asSlice(document["proxy-groups"])) != 9 {
		t.Fatalf("unexpected proxy-group count: %d", len(asSlice(document["proxy-groups"])))
	}
	if len(asMap(document["rule-providers"])) != 26 {
		t.Fatalf("unexpected rule-provider count: %d", len(asMap(document["rule-providers"])))
	}
	if len(asSlice(document["rules"])) != 31 {
		t.Fatalf("unexpected rule count: %d", len(asSlice(document["rules"])))
	}
	for _, forbidden := range []string{"x-hwid", "external-controller", "secret:"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("template contains forbidden material %q", forbidden)
		}
	}
	if regexp.MustCompile(`\p{Cyrillic}`).Match(body) {
		t.Fatal("template contains a Cyrillic label")
	}
}

func TestBuildLinksWithRussiaTemplate(t *testing.T) {
	temporary := t.TempDir()
	writeYAML := func(name string, value map[string]any) string {
		body, err := yaml.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(temporary, name)
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	currentPath := writeYAML("current.yaml", validCurrent())
	linksPath := filepath.Join(temporary, "links.txt")
	link := "vless://00000000-0000-0000-0000-000000000000@example.invalid:443#one\n"
	if err := os.WriteFile(linksPath, []byte(link), 0o600); err != nil {
		t.Fatal(err)
	}
	outputPath := filepath.Join(temporary, "output.yaml")
	templatePath := filepath.Join("..", "rootfs", "usr", "share", "ssclash-party", "templates", "russia.yaml")
	providerPath := "./managed-sources/" + strings.Repeat("b", 64) + ".txt"
	if err := buildManagedProfile(buildOptions{
		InputPath:    linksPath,
		SourceKind:   "links",
		RulesMode:    "template",
		TemplateID:   "russia",
		TemplatePath: templatePath,
		ProviderPath: providerPath,
		CurrentPath:  currentPath,
		OutputPath:   outputPath,
		Policy:       defaultPolicy(),
	}); err != nil {
		t.Fatalf("build links profile: %v", err)
	}
	generated, _, err := readYAML(outputPath)
	if err != nil {
		t.Fatalf("read generated profile: %v", err)
	}
	provider := asMap(asMap(generated["proxy-providers"])[localProviderName])
	if provider["path"] != providerPath || provider["type"] != "file" {
		t.Fatalf("unexpected local provider: %#v", provider)
	}
	groups := asSlice(generated["proxy-groups"])
	for _, item := range groups {
		group := asMap(item)
		if _, exists := group["include-all"]; exists {
			t.Fatalf("provider-backed group was not normalized: %#v", group)
		}
	}
}

func TestBuildNodesOnlyUsesRussiaTemplate(t *testing.T) {
	temporary := t.TempDir()
	writeYAML := func(name string, value map[string]any) string {
		body, err := yaml.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(temporary, name)
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	nodes := map[string]any{
		"proxies": []any{
			map[string]any{"name": "imported-node", "type": "direct"},
		},
	}
	outputPath := filepath.Join(temporary, "output.yaml")
	if err := buildManagedProfile(buildOptions{
		InputPath:    writeYAML("nodes.yaml", nodes),
		SourceKind:   "nodes",
		RulesMode:    "auto",
		TemplateID:   "russia",
		TemplatePath: filepath.Join("..", "rootfs", "usr", "share", "ssclash-party", "templates", "russia.yaml"),
		CurrentPath:  writeYAML("current.yaml", validCurrent()),
		OutputPath:   outputPath,
		Policy:       defaultPolicy(),
	}); err != nil {
		t.Fatalf("build nodes-only profile: %v", err)
	}

	generated, _, err := readYAML(outputPath)
	if err != nil {
		t.Fatalf("read generated profile: %v", err)
	}
	if len(asSlice(generated["proxies"])) != 1 || len(asSlice(generated["proxy-groups"])) != 9 {
		t.Fatalf("nodes or template policy were not imported: %#v", generated)
	}
	if nonEmptyString(asMap(asSlice(generated["proxies"])[0])["name"]) != "imported-node" {
		t.Fatalf("unexpected imported proxies: %#v", generated["proxies"])
	}
}

func TestForceTemplateDiscardsCompleteRemotePolicy(t *testing.T) {
	temporary := t.TempDir()
	writeYAML := func(name string, value map[string]any) string {
		body, err := yaml.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(temporary, name)
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	remote := map[string]any{
		"proxies": []any{
			map[string]any{"name": "remote-node", "type": "direct"},
		},
		"proxy-groups": []any{
			map[string]any{"name": "REMOTE-POLICY", "type": "select", "proxies": []any{"remote-node"}},
		},
		"rules": []any{"MATCH,REMOTE-POLICY"},
	}
	outputPath := filepath.Join(temporary, "output.yaml")
	if err := buildManagedProfile(buildOptions{
		InputPath:    writeYAML("remote.yaml", remote),
		SourceKind:   "full",
		RulesMode:    "template",
		TemplateID:   "russia",
		TemplatePath: filepath.Join("..", "rootfs", "usr", "share", "ssclash-party", "templates", "russia.yaml"),
		CurrentPath:  writeYAML("current.yaml", validCurrent()),
		OutputPath:   outputPath,
		Policy:       defaultPolicy(),
	}); err != nil {
		t.Fatalf("build forced-template profile: %v", err)
	}

	generated, _, err := readYAML(outputPath)
	if err != nil {
		t.Fatalf("read generated profile: %v", err)
	}
	for _, item := range asSlice(generated["proxy-groups"]) {
		if nonEmptyString(asMap(item)["name"]) == "REMOTE-POLICY" {
			t.Fatal("a forced PARTY template retained the remote policy group")
		}
	}
	if len(asSlice(generated["rules"])) != 31 {
		t.Fatalf("unexpected forced-template rules: %#v", generated["rules"])
	}
}
