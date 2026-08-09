package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTemplateTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func testTemplateYAML(group, target string) string {
	return "proxy-groups:\n" +
		"  - name: " + group + "\n" +
		"    type: select\n" +
		"    include-all: true\n" +
		"rules:\n" +
		"  - MATCH," + target + "\n"
}

func writeBuiltinTemplateStore(t *testing.T, root string) {
	t.Helper()
	catalog := builtinCatalog{}
	catalog.Templates = append(catalog.Templates, struct {
		ID          string `json:"id"`
		Version     int    `json:"version"`
		Name        string `json:"name"`
		Description string `json:"description"`
	}{ID: "russia", Version: 2, Name: "Russia", Description: "Built in"})
	data, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	writeTemplateTestFile(t, filepath.Join(root, "catalog.json"), string(data))
	writeTemplateTestFile(t, filepath.Join(root, "russia.yaml"), testTemplateYAML("PROXY", "PROXY"))
}

func TestSanitizeTemplateDocumentSeparatesNodesAndRouterSettings(t *testing.T) {
	input := map[string]any{
		"mixed-port": 7890,
		"secret":     "must-not-survive",
		"proxies": []any{
			map[string]any{"name": "Private node", "type": "ss", "password": "secret"},
		},
		"dns": map[string]any{
			"enable":        true,
			"listen":        "0.0.0.0:53",
			"enhanced-mode": "fake-ip",
			"nameserver":    []any{"https://1.1.1.1/dns-query"},
		},
		"proxy-groups": []any{
			map[string]any{
				"name": "PROXY", "type": "select",
				"proxies": []any{"Private node", "DIRECT"},
				"use":     []any{"remote"},
			},
		},
		"rule-providers": map[string]any{
			"remote": map[string]any{
				"type": "http", "behavior": "domain", "format": "mrs",
				"url": "https://example.invalid/domains.mrs", "path": "./unsafe/cache.mrs",
			},
			"local": map[string]any{
				"type": "file", "behavior": "classical", "path": "/etc/private.yaml",
			},
			"inline": map[string]any{
				"type": "inline", "behavior": "domain", "payload": []any{"example.com"},
			},
		},
		"rules": []any{
			"RULE-SET,remote,PROXY",
			"RULE-SET,local,PROXY",
			"RULE-SET,inline,DIRECT",
			"MATCH,PROXY",
		},
	}

	document, report, err := sanitizeTemplateDocument(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"mixed-port", "secret", "proxies"} {
		if _, exists := document[key]; exists {
			t.Fatalf("protected key %q survived sanitation", key)
		}
	}
	dns := asMap(document["dns"])
	if _, exists := dns["enhanced-mode"]; exists {
		t.Fatal("router-owned DNS mode survived sanitation")
	}
	if len(stringSlice(dns["nameserver"])) != 1 {
		t.Fatal("safe DNS upstreams were not preserved")
	}
	providers := asMap(document["rule-providers"])
	if providers["local"] != nil || providers["remote"] == nil || providers["inline"] == nil {
		t.Fatalf("unexpected sanitized providers: %#v", providers)
	}
	if _, exists := asMap(providers["remote"])["path"]; exists {
		t.Fatal("provider cache path survived sanitation")
	}
	group := asMap(asSlice(document["proxy-groups"])[0])
	if includeAll, _ := group["include-all"].(bool); !includeAll {
		t.Fatal("group was not normalized to receive active source nodes")
	}
	if got := strings.Join(stringSlice(group["proxies"]), ","); got != "DIRECT" {
		t.Fatalf("concrete node was not removed: %q", got)
	}
	rules := stringSlice(document["rules"])
	if len(rules) != 3 || strings.Contains(strings.Join(rules, "\n"), "RULE-SET,local") {
		t.Fatalf("dependent local-provider rule was not removed: %#v", rules)
	}
	if len(report.Removed) == 0 || len(report.Adjusted) == 0 {
		t.Fatalf("sanitation report is incomplete: %#v", report)
	}
}

func TestSanitizeTemplateRejectsUnsafeProviderAndMissingFallback(t *testing.T) {
	input := map[string]any{
		"proxy-groups": []any{map[string]any{"name": "PROXY", "type": "select", "include-all": true}},
		"rule-providers": map[string]any{
			"signed": map[string]any{
				"type": "http", "behavior": "domain", "url": "https://example.invalid/rules?token=secret",
			},
		},
		"rules": []any{"RULE-SET,signed,PROXY"},
	}
	if _, _, err := sanitizeTemplateDocument(input); err == nil || !strings.Contains(err.Error(), "usable rules") {
		t.Fatalf("expected missing-rule error, got %v", err)
	}
}

func TestCustomTemplateStoreLifecycleAndHistory(t *testing.T) {
	root := t.TempDir()
	builtinDir := filepath.Join(root, "builtin")
	customDir := filepath.Join(root, "custom")
	legacyDir := filepath.Join(root, "legacy")
	writeBuiltinTemplateStore(t, builtinDir)
	writeTemplateTestFile(t, filepath.Join(legacyDir, "old-list.txt"), "# retained\nexample.com\nexample.net\n")

	input := filepath.Join(root, "input.yaml")
	writeTemplateTestFile(t, input, testTemplateYAML("CUSTOM", "CUSTOM"))
	record, err := saveCustomTemplate(builtinDir, customDir, "custom", "Custom", "First revision", input, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if record.Revision != 1 || record.ReadOnly || record.Source != "custom" {
		t.Fatalf("unexpected initial record: %#v", record)
	}

	writeTemplateTestFile(t, input, testTemplateYAML("CUSTOM", "DIRECT"))
	record, err = saveCustomTemplate(builtinDir, customDir, "custom", "Custom", "Second revision", input, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	if record.Revision != 2 || len(record.History) != 1 || record.History[0] != 1 {
		t.Fatalf("history was not recorded: %#v", record)
	}
	if _, err := saveCustomTemplate(builtinDir, customDir, "custom", "Custom", "Conflict", input, 1, ""); err == nil {
		t.Fatal("stale revision unexpectedly overwrote the template")
	}

	catalog, err := listTemplates(builtinDir, customDir, legacyDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Templates) != 2 || len(catalog.LegacyLists) != 1 || catalog.LegacyLists[0].Entries != 2 {
		t.Fatalf("unexpected catalog: %#v", catalog)
	}

	record, err = restoreCustomTemplate(builtinDir, customDir, "custom", 1, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if record.Revision != 3 || !strings.Contains(record.YAML, "MATCH,CUSTOM") {
		t.Fatalf("unexpected restored template: revision=%d yaml=%q", record.Revision, record.YAML)
	}
	if err := deleteCustomTemplate(builtinDir, customDir, "custom", 3); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(customDir, "custom")); !os.IsNotExist(err) {
		t.Fatal("deleted template remains in the active store")
	}
	trash, err := os.ReadDir(filepath.Join(customDir, ".trash"))
	if err != nil || len(trash) != 1 {
		t.Fatalf("deleted template was not retained recoverably: entries=%d err=%v", len(trash), err)
	}
}

func TestTemplateDocumentAcceptsCustomStoreLayout(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom", "template.yaml")
	writeTemplateTestFile(t, path, testTemplateYAML("PROXY", "PROXY"))
	if _, err := templateDocument(path, "custom"); err != nil {
		t.Fatal(err)
	}
}
