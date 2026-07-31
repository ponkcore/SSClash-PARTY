package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

const (
	localProviderName = "PARTY"
	maxLinkLineSize   = 16 * 1024
)

var (
	uriLinePattern           = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+$`)
	managedSourcePathPattern = regexp.MustCompile(`^\./managed-sources/[a-f0-9]{64}\.txt$`)
	templateIDPattern        = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
)

type sourceInspection struct {
	Kind          string   `json:"kind"`
	Reason        string   `json:"reason"`
	SourceSHA256  string   `json:"source_sha256"`
	InlineProxies int      `json:"inline_proxies"`
	Providers     int      `json:"proxy_providers"`
	Groups        int      `json:"proxy_groups"`
	Rules         int      `json:"rules"`
	LinkCount     int      `json:"link_count"`
	SkippedLines  int      `json:"skipped_lines"`
	Encoding      string   `json:"encoding,omitempty"`
	Links         []string `json:"-"`
}

func readLimited(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() <= 0 {
		return nil, nil
	}
	if info.Size() > maxYAMLSize {
		return nil, fmt.Errorf("%s exceeds the %d-byte limit", path, maxYAMLSize)
	}
	return os.ReadFile(path)
}

func normalizeURILines(text string) ([]string, int) {
	seen := make(map[string]bool)
	links := make([]string, 0)
	skipped := 0
	for _, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if len(line) > maxLinkLineSize || !uriLinePattern.MatchString(line) {
			skipped++
			continue
		}
		scheme := strings.ToLower(line[:strings.Index(line, "://")])
		switch scheme {
		case "data", "file", "javascript":
			skipped++
			continue
		}
		if !seen[line] {
			seen[line] = true
			links = append(links, line)
		}
	}
	return links, skipped
}

func compactBase64(text string) string {
	return strings.Map(func(character rune) rune {
		if unicode.IsSpace(character) {
			return -1
		}
		return character
	}, text)
}

func decodeOuterBase64(text string) ([]byte, bool) {
	compact := compactBase64(text)
	if compact == "" || strings.Contains(compact, "://") {
		return nil, false
	}
	encodings := []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	for _, encoding := range encodings {
		decoded, err := encoding.DecodeString(compact)
		if err == nil && len(decoded) > 0 && len(decoded) <= maxYAMLSize && utf8.Valid(decoded) {
			return decoded, true
		}
	}
	return nil, false
}

func looksLikeJSON(text string) bool {
	trimmed := strings.TrimSpace(text)
	return strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[")
}

func looksLikeHTML(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	return strings.HasPrefix(lower, "<!doctype html") ||
		strings.HasPrefix(lower, "<html") ||
		strings.HasPrefix(lower, "<?xml")
}

func inspectSourceBytes(data []byte) sourceInspection {
	inspection := sourceInspection{Kind: "empty", Reason: "empty_response"}
	if len(strings.TrimSpace(string(data))) == 0 {
		return inspection
	}

	var document map[string]any
	if err := yaml.Unmarshal(data, &document); err == nil && document != nil {
		inspection.InlineProxies = len(asSlice(document["proxies"]))
		inspection.Providers = len(asMap(document["proxy-providers"]))
		inspection.Groups = len(asSlice(document["proxy-groups"]))
		inspection.Rules = len(asSlice(document["rules"]))
		if inspection.InlineProxies > 0 || inspection.Providers > 0 {
			inspection.Kind = "nodes"
			inspection.Reason = "nodes_only_yaml"
			if inspection.Groups > 0 && inspection.Rules > 0 {
				inspection.Kind = "full"
				inspection.Reason = "complete_mihomo_yaml"
			}
			inspection.SourceSHA256 = sha256Hex(data)
			return inspection
		}
	}

	links, skipped := normalizeURILines(string(data))
	encoding := "plain"
	if len(links) == 0 {
		if decoded, ok := decodeOuterBase64(string(data)); ok {
			links, skipped = normalizeURILines(string(decoded))
			encoding = "base64"
		}
	}
	if len(links) > 0 {
		canonical := []byte(strings.Join(links, "\n") + "\n")
		inspection.Kind = "links"
		inspection.Reason = "proxy_uri_list"
		inspection.SourceSHA256 = sha256Hex(canonical)
		inspection.LinkCount = len(links)
		inspection.SkippedLines = skipped
		inspection.Encoding = encoding
		inspection.Links = links
		return inspection
	}

	text := string(data)
	switch {
	case looksLikeHTML(text):
		inspection.Kind = "unsupported"
		inspection.Reason = "html_response"
	case looksLikeJSON(text):
		inspection.Kind = "unsupported"
		inspection.Reason = "unsupported_json"
	default:
		inspection.Kind = "unsupported"
		inspection.Reason = "no_usable_proxies"
	}
	return inspection
}

func writeNormalizedLinks(path string, links []string) error {
	if path == "" {
		return nil
	}
	if len(links) == 0 {
		return errors.New("no normalized proxy links are available")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(strings.Join(links, "\n")+"\n"), 0o600)
}

func runInspectCommand(arguments []string) error {
	flags := flag.NewFlagSet("inspect", flag.ContinueOnError)
	inputPath := flags.String("input", "", "path to a downloaded subscription or proxy-link list")
	normalizedPath := flags.String("normalized-links", "", "optional output path for normalized proxy links")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if *inputPath == "" {
		return errors.New("-input is required")
	}
	data, err := readLimited(*inputPath)
	if err != nil {
		return err
	}
	inspection := inspectSourceBytes(data)
	if inspection.Kind == "links" {
		if err := writeNormalizedLinks(*normalizedPath, inspection.Links); err != nil {
			return err
		}
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(inspection)
}

func validManagedSourcePath(path string) bool {
	return managedSourcePathPattern.MatchString(path)
}

func validateTemplate(document map[string]any) error {
	if len(asSlice(document["proxy-groups"])) == 0 {
		return errors.New("template has no proxy-groups")
	}
	if len(asSlice(document["rules"])) == 0 {
		return errors.New("template has no rules")
	}
	if len(asSlice(document["proxies"])) != 0 || len(asMap(document["proxy-providers"])) != 0 {
		return errors.New("template must not contain proxy credentials or proxy providers")
	}
	for _, key := range append([]string{
		"external-controller",
		"routing-mark",
		"secret",
		"tproxy-port",
	}, unsafeTopLevelKeys...) {
		if _, exists := document[key]; exists {
			return fmt.Errorf("template contains protected router key %q", key)
		}
	}
	return nil
}

func templateDocument(path, templateID string) (map[string]any, error) {
	if !templateIDPattern.MatchString(templateID) {
		return nil, errors.New("template ID is invalid")
	}
	if filepath.Base(path) != templateID+".yaml" {
		return nil, errors.New("template filename does not match its ID")
	}
	document, _, err := readYAML(path)
	if err != nil {
		return nil, err
	}
	if err := validateTemplate(document); err != nil {
		return nil, err
	}
	return document, nil
}

func importNodes(template, source map[string]any) map[string]any {
	result := cloneMap(template)
	if proxies := asSlice(source["proxies"]); len(proxies) > 0 {
		result["proxies"] = cloneSlice(proxies)
	}
	if providers := asMap(source["proxy-providers"]); len(providers) > 0 {
		result["proxy-providers"] = cloneMap(providers)
	}
	return result
}

func addLocalProvider(template map[string]any, providerPath string) (map[string]any, error) {
	if !validManagedSourcePath(providerPath) {
		return nil, errors.New("managed proxy source path is invalid")
	}
	result := cloneMap(template)
	result["proxy-providers"] = map[string]any{
		localProviderName: map[string]any{
			"type": "file",
			"path": providerPath,
		},
	}
	return result, nil
}

type buildOptions struct {
	InputPath       string
	SourceKind      string
	RulesMode       string
	TemplateID      string
	TemplatePath    string
	ProviderPath    string
	CurrentPath     string
	OutputPath      string
	ObservedLinks   int
	ObservedSkipped int
	Policy          routerPolicy
}

func buildManagedProfile(options buildOptions) error {
	if options.SourceKind != "full" && options.SourceKind != "nodes" && options.SourceKind != "links" {
		return errors.New("source kind must be full, nodes, or links")
	}
	if options.RulesMode != "auto" && options.RulesMode != "template" {
		return errors.New("rules mode must be auto or template")
	}
	if options.SourceKind != "full" && options.RulesMode == "auto" {
		options.RulesMode = "template"
	}

	inputBytes, err := readLimited(options.InputPath)
	if err != nil {
		return err
	}
	inspection := inspectSourceBytes(inputBytes)
	if inspection.Kind != options.SourceKind {
		return fmt.Errorf("input was classified as %s instead of %s", inspection.Kind, options.SourceKind)
	}
	current, _, err := readYAML(options.CurrentPath)
	if err != nil {
		return err
	}

	var source map[string]any
	if options.SourceKind != "links" {
		if err := yaml.Unmarshal(inputBytes, &source); err != nil || source == nil {
			return errors.New("proxy source is not a YAML mapping")
		}
	}

	rulesSource := "remote"
	templateID := ""
	trustedProviderPath := ""
	candidate := source
	if options.RulesMode == "template" {
		template, err := templateDocument(options.TemplatePath, options.TemplateID)
		if err != nil {
			return err
		}
		templateID = options.TemplateID
		rulesSource = "template"
		if options.SourceKind == "links" {
			candidate, err = addLocalProvider(template, options.ProviderPath)
			if err != nil {
				return err
			}
			trustedProviderPath = options.ProviderPath
		} else {
			candidate = importNodes(template, source)
		}
	}

	policy := options.Policy
	policy.TrustedLocalProviderPath = trustedProviderPath
	merged, normalized, normalizedCaches, generatedSecret, err := overlayRouterSettings(candidate, current, policy)
	if err != nil {
		return err
	}
	outputBytes, err := writeOutput(options.OutputPath, merged)
	if err != nil {
		return err
	}

	inputLinks := inspection.LinkCount
	skippedLines := inspection.SkippedLines
	if options.ObservedLinks > inputLinks {
		inputLinks = options.ObservedLinks
	}
	if options.ObservedSkipped > skippedLines {
		skippedLines = options.ObservedSkipped
	}
	summary := mergeSummary{
		InlineProxies:             len(asSlice(merged["proxies"])),
		ProxyProviders:            countMap(merged["proxy-providers"]),
		ProxyGroups:               len(asSlice(merged["proxy-groups"])),
		RuleProviders:             countMap(merged["rule-providers"]),
		Rules:                     len(asSlice(merged["rules"])),
		DNSMode:                   dnsMode(merged),
		SourceSHA256:              inspection.SourceSHA256,
		OutputSHA256:              sha256Hex(outputBytes),
		GeneratedControllerSecret: generatedSecret,
		RuntimeRestartRequired:    runtimeRestartRequired(current, merged),
		NormalizedGroups:          normalized,
		NormalizedCaches:          normalizedCaches,
		SourceFormat:              options.SourceKind,
		RulesSource:               rulesSource,
		TemplateID:                templateID,
		InputLinks:                inputLinks,
		SkippedLines:              skippedLines,
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(summary)
}

func runBuildCommand(arguments []string) error {
	flags := flag.NewFlagSet("build", flag.ContinueOnError)
	var options buildOptions
	flags.StringVar(&options.InputPath, "input", "", "path to the inspected proxy source")
	flags.StringVar(&options.SourceKind, "source-kind", "", "classified source kind: full, nodes, or links")
	flags.StringVar(&options.RulesMode, "rules-mode", "auto", "routing policy source: auto or template")
	flags.StringVar(&options.TemplateID, "template-id", "russia", "trusted template catalog ID")
	flags.StringVar(&options.TemplatePath, "template", "", "path to the trusted template YAML")
	flags.StringVar(&options.ProviderPath, "provider-path", "", "managed source path relative to the Mihomo home")
	flags.StringVar(&options.CurrentPath, "current", "", "path to the current router Mihomo YAML")
	flags.StringVar(&options.OutputPath, "output", "", "path for the generated router-safe YAML")
	flags.IntVar(&options.ObservedLinks, "observed-links", 0, "link count reported by subscription inspection")
	flags.IntVar(&options.ObservedSkipped, "observed-skipped", 0, "skipped line count reported by subscription inspection")
	flags.StringVar(&options.Policy.Controller, "controller", "", "private controller IP and port")
	flags.StringVar(&options.Policy.DNSListen, "dns-listen", "", "loopback DNS IP and port")
	flags.StringVar(&options.Policy.DNSMode, "dns-mode", "preserve", "protected DNS mode")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if options.InputPath == "" || options.CurrentPath == "" || options.OutputPath == "" {
		return errors.New("-input, -current, and -output are required")
	}
	if options.RulesMode == "template" || options.SourceKind != "full" {
		if options.TemplatePath == "" {
			return errors.New("-template is required for template routing")
		}
	}
	return buildManagedProfile(options)
}
