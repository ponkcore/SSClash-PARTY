package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"
)

const (
	maxTemplateNameLength        = 96
	maxTemplateDescriptionLength = 512
	maxTemplateItemNameLength    = 128
	maxTemplateRuleLength        = 8192
	maxTemplateHistory           = 20
)

type templateChange struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type templateSanitizeReport struct {
	Removed  []templateChange `json:"removed"`
	Adjusted []templateChange `json:"adjusted"`
	Warnings []string         `json:"warnings"`
}

func (report *templateSanitizeReport) remove(path, reason string) {
	report.Removed = append(report.Removed, templateChange{Path: path, Reason: reason})
}

func (report *templateSanitizeReport) adjust(path, reason string) {
	report.Adjusted = append(report.Adjusted, templateChange{Path: path, Reason: reason})
}

type templateSummary struct {
	Groups        int `json:"groups"`
	RuleProviders int `json:"rule_providers"`
	InlineLists   int `json:"inline_lists"`
	Rules         int `json:"rules"`
}

type templatePrepared struct {
	OK       bool                   `json:"ok"`
	Changed  bool                   `json:"changed"`
	YAML     string                 `json:"yaml"`
	Document map[string]any         `json:"document"`
	Summary  templateSummary        `json:"summary"`
	Report   templateSanitizeReport `json:"report"`
}

type templateMetadata struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Revision    int    `json:"revision"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type templateRecord struct {
	templateMetadata
	Source   string          `json:"source"`
	ReadOnly bool            `json:"read_only"`
	Version  int             `json:"version,omitempty"`
	Summary  templateSummary `json:"summary"`
	YAML     string          `json:"yaml,omitempty"`
	Document map[string]any  `json:"document,omitempty"`
	History  []int           `json:"history,omitempty"`
}

type legacyTemplateList struct {
	Name    string `json:"name"`
	Entries int    `json:"entries"`
}

type templateCatalogResponse struct {
	SchemaVersion int                  `json:"schema_version"`
	Templates     []templateRecord     `json:"templates"`
	LegacyLists   []legacyTemplateList `json:"legacy_lists"`
	TrashCount    int                  `json:"trash_count"`
}

type builtinCatalog struct {
	Templates []struct {
		ID          string `json:"id"`
		Version     int    `json:"version"`
		Name        string `json:"name"`
		Description string `json:"description"`
	} `json:"templates"`
}

var allowedTemplateTopLevel = map[string]bool{
	"dns":            true,
	"hosts":          true,
	"proxy-groups":   true,
	"rule-providers": true,
	"rules":          true,
	"sniffer":        true,
	"sub-rules":      true,
}

var protectedTemplateDNSKeys = map[string]bool{
	"enable":              true,
	"enhanced-mode":       true,
	"fake-ip-filter":      true,
	"fake-ip-filter-mode": true,
	"fake-ip-range":       true,
	"ipv6":                true,
	"listen":              true,
}

var allowedGroupKeys = map[string]bool{
	"disable-udp":         true,
	"exclude-filter":      true,
	"exclude-type":        true,
	"expected-status":     true,
	"filter":              true,
	"hidden":              true,
	"icon":                true,
	"include-all":         true,
	"include-all-proxies": true,
	"interval":            true,
	"lazy":                true,
	"max-failed-times":    true,
	"name":                true,
	"proxies":             true,
	"strategy":            true,
	"timeout":             true,
	"tolerance":           true,
	"type":                true,
	"url":                 true,
}

var allowedProviderKeys = map[string]bool{
	"behavior": true,
	"format":   true,
	"interval": true,
	"payload":  true,
	"proxy":    true,
	"type":     true,
	"url":      true,
}

var builtinPolicyTargets = map[string]bool{
	"COMPATIBLE":  true,
	"DIRECT":      true,
	"PASS":        true,
	"REJECT":      true,
	"REJECT-DROP": true,
}

func templateSummaryFor(document map[string]any) templateSummary {
	providers := asMap(document["rule-providers"])
	inline := 0
	for _, item := range providers {
		if strings.EqualFold(nonEmptyString(asMap(item)["type"]), "inline") {
			inline++
		}
	}
	return templateSummary{
		Groups:        len(asSlice(document["proxy-groups"])),
		RuleProviders: len(providers),
		InlineLists:   inline,
		Rules:         len(asSlice(document["rules"])),
	}
}

func safeTemplateText(value string, maximum int, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%s is required", field)
	}
	if len(value) > maximum {
		return "", fmt.Errorf("%s exceeds %d bytes", field, maximum)
	}
	for _, character := range value {
		if unicode.IsControl(character) && character != '\t' {
			return "", fmt.Errorf("%s contains control characters", field)
		}
	}
	return value, nil
}

func validTemplateItemName(value string) bool {
	if strings.TrimSpace(value) != value || value == "" || len(value) > maxTemplateItemNameLength || strings.Contains(value, ",") {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func sanitizeMapKeys(value map[string]any, allowed map[string]bool, prefix string, report *templateSanitizeReport) {
	for key := range value {
		if !allowed[key] {
			delete(value, key)
			report.remove(prefix+"."+key, "not part of the PARTY template policy contract")
		}
	}
}

func sanitizeTemplateDNS(document map[string]any, report *templateSanitizeReport) {
	dns := asMap(document["dns"])
	if dns == nil {
		if _, exists := document["dns"]; exists {
			delete(document, "dns")
			report.remove("dns", "DNS must be a mapping")
		}
		return
	}
	for key := range protectedTemplateDNSKeys {
		if _, exists := dns[key]; exists {
			delete(dns, key)
			report.remove("dns."+key, "owned by Router Integration")
		}
	}
	if len(dns) == 0 {
		delete(document, "dns")
	}
}

func sanitizeProviderURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" &&
		parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func positiveTemplateInteger(value any, fallback int) int {
	switch typed := value.(type) {
	case int:
		if typed > 0 {
			return typed
		}
	case int64:
		if typed > 0 && typed <= int64(^uint(0)>>1) {
			return int(typed)
		}
	case uint64:
		if typed > 0 && typed <= uint64(^uint(0)>>1) {
			return int(typed)
		}
	case float64:
		if typed > 0 && typed == float64(int(typed)) {
			return int(typed)
		}
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil && parsed > 0 {
			return parsed
		}
	}
	return fallback
}

func sanitizeRuleProviders(document map[string]any, report *templateSanitizeReport) map[string]bool {
	original := asMap(document["rule-providers"])
	providers := make(map[string]any)
	valid := make(map[string]bool)
	for name, item := range original {
		path := "rule-providers." + name
		if !validTemplateItemName(name) {
			report.remove(path, "provider name is empty, too long, or contains control characters")
			continue
		}
		provider := cloneMap(asMap(item))
		if provider == nil {
			report.remove(path, "provider must be a mapping")
			continue
		}
		sanitizeMapKeys(provider, allowedProviderKeys, path, report)
		providerType := strings.ToLower(nonEmptyString(provider["type"]))
		behavior := strings.ToLower(nonEmptyString(provider["behavior"]))
		if behavior != "domain" && behavior != "ipcidr" && behavior != "classical" {
			report.remove(path, "provider behavior must be domain, ipcidr, or classical")
			continue
		}
		provider["behavior"] = behavior
		switch providerType {
		case "http":
			if !sanitizeProviderURL(nonEmptyString(provider["url"])) {
				report.remove(path, "HTTP providers require a credential-free HTTPS URL without query or fragment")
				continue
			}
			provider["type"] = "http"
			format := strings.ToLower(nonEmptyString(provider["format"]))
			if format != "mrs" && format != "text" && format != "yaml" {
				format = "yaml"
				report.adjust(path+".format", "set to yaml because the imported format was missing or unsupported")
			}
			provider["format"] = format
			interval := positiveTemplateInteger(provider["interval"], 86400)
			if interval != positiveTemplateInteger(provider["interval"], 0) {
				report.adjust(path+".interval", "set to the safe 86400-second default")
			}
			provider["interval"] = interval
			delete(provider, "payload")
		case "inline":
			payload := asSlice(provider["payload"])
			clean := make([]any, 0, len(payload))
			for index, entry := range payload {
				text := nonEmptyString(entry)
				if text == "" || len(text) > maxTemplateRuleLength || strings.ContainsRune(text, '\x00') {
					report.remove(fmt.Sprintf("%s.payload[%d]", path, index), "inline entry is empty or invalid")
					continue
				}
				clean = append(clean, text)
			}
			if len(clean) == 0 {
				report.remove(path, "inline provider has no usable payload entries")
				continue
			}
			provider["type"] = "inline"
			provider["payload"] = clean
			delete(provider, "url")
			delete(provider, "interval")
			delete(provider, "format")
		case "file":
			report.remove(path, "local file providers are not portable; import the list as an inline provider")
			continue
		default:
			report.remove(path, "provider type must be http or inline")
			continue
		}
		providers[name] = provider
		valid[name] = true
	}
	if len(providers) == 0 {
		delete(document, "rule-providers")
	} else {
		document["rule-providers"] = providers
	}
	return valid
}

func sanitizeProxyGroups(document map[string]any, report *templateSanitizeReport) (map[string]bool, error) {
	original := asSlice(document["proxy-groups"])
	groupNames := make(map[string]bool)
	for index, item := range original {
		name := nonEmptyString(asMap(item)["name"])
		if !validTemplateItemName(name) {
			return nil, fmt.Errorf("proxy-groups[%d] has an invalid name", index)
		}
		if groupNames[name] {
			return nil, fmt.Errorf("proxy group %q is duplicated", name)
		}
		groupNames[name] = true
	}

	groups := make([]any, 0, len(original))
	allowedTypes := map[string]bool{
		"fallback": true, "load-balance": true, "relay": true, "select": true, "url-test": true,
	}
	for index, item := range original {
		path := fmt.Sprintf("proxy-groups[%d]", index)
		group := cloneMap(asMap(item))
		sanitizeMapKeys(group, allowedGroupKeys, path, report)
		name := nonEmptyString(group["name"])
		groupType := strings.ToLower(nonEmptyString(group["type"]))
		if !allowedTypes[groupType] {
			return nil, fmt.Errorf("proxy group %q has unsupported type %q", name, groupType)
		}
		group["name"] = name
		group["type"] = groupType
		if rawURL := nonEmptyString(group["url"]); rawURL != "" && !sanitizeProviderURL(rawURL) {
			delete(group, "url")
			report.remove(path+".url", "health checks require a credential-free HTTPS URL")
		}
		if (groupType == "url-test" || groupType == "fallback" || groupType == "load-balance") && nonEmptyString(group["url"]) == "" {
			group["url"] = "https://www.gstatic.com/generate_204"
			report.adjust(path+".url", "set to the PARTY HTTPS health-check default")
		}

		removedNodes := false
		if _, exists := asMap(item)["use"]; exists {
			removedNodes = true
			report.remove(path+".use", "proxy-provider references belong to the node source")
		}
		cleanProxies := make([]any, 0)
		seen := make(map[string]bool)
		for proxyIndex, entry := range asSlice(group["proxies"]) {
			target := nonEmptyString(entry)
			if target == "" || target == name || (!groupNames[target] && !builtinPolicyTargets[target]) {
				removedNodes = true
				report.remove(fmt.Sprintf("%s.proxies[%d]", path, proxyIndex), "concrete nodes and invalid group references are supplied by the active source")
				continue
			}
			if !seen[target] {
				seen[target] = true
				cleanProxies = append(cleanProxies, target)
			}
		}
		if len(cleanProxies) == 0 {
			delete(group, "proxies")
		} else {
			group["proxies"] = cleanProxies
		}
		includeAll, _ := group["include-all"].(bool)
		if removedNodes || (len(cleanProxies) == 0 && !includeAll) {
			group["include-all"] = true
			report.adjust(path+".include-all", "enabled so the group receives nodes from the active subscription or proxy-link source")
		}
		groups = append(groups, group)
	}
	document["proxy-groups"] = groups
	return groupNames, nil
}

func sanitizeProviderTargets(document map[string]any, groups map[string]bool, report *templateSanitizeReport) {
	for name, item := range asMap(document["rule-providers"]) {
		provider := asMap(item)
		target := nonEmptyString(provider["proxy"])
		if target != "" && !groups[target] && !builtinPolicyTargets[target] {
			delete(provider, "proxy")
			report.remove("rule-providers."+name+".proxy", "provider download target is not a template group or Mihomo built-in policy")
		}
	}
}

func splitRuleFields(rule string) []string {
	fields := make([]string, 0, 4)
	start, depth := 0, 0
	quote := rune(0)
	for index, character := range rule {
		switch {
		case quote != 0:
			if character == quote {
				quote = 0
			}
		case character == '\'' || character == '"':
			quote = character
		case character == '(' || character == '[' || character == '{':
			depth++
		case character == ')' || character == ']' || character == '}':
			if depth > 0 {
				depth--
			}
		case character == ',' && depth == 0:
			fields = append(fields, strings.TrimSpace(rule[start:index]))
			start = index + 1
		}
	}
	fields = append(fields, strings.TrimSpace(rule[start:]))
	return fields
}

func sanitizeRules(document map[string]any, groups, providers map[string]bool, report *templateSanitizeReport) error {
	original := asSlice(document["rules"])
	clean := make([]any, 0, len(original))
	providerUse := make(map[string]bool)
	subRules := asMap(document["sub-rules"])
	hasFallback := false
	for index, item := range original {
		path := fmt.Sprintf("rules[%d]", index)
		rule := nonEmptyString(item)
		if rule == "" || len(rule) > maxTemplateRuleLength || strings.ContainsRune(rule, '\x00') {
			report.remove(path, "rule is empty or invalid")
			continue
		}
		fields := splitRuleFields(rule)
		if len(fields) < 2 {
			report.remove(path, "rule does not contain a policy target")
			continue
		}
		ruleType := strings.ToUpper(fields[0])
		if ruleType == "RULE-SET" {
			if len(fields) < 3 || !providers[fields[1]] {
				report.remove(path, "rule references a provider that was removed or does not exist")
				continue
			}
			providerUse[fields[1]] = true
		}
		targetIndex := len(fields) - 1
		if strings.EqualFold(fields[targetIndex], "no-resolve") {
			targetIndex--
		}
		if targetIndex < 1 {
			report.remove(path, "rule has no policy target")
			continue
		}
		target := fields[targetIndex]
		validTarget := groups[target] || builtinPolicyTargets[target]
		if ruleType == "SUB-RULE" {
			_, validTarget = subRules[target]
		}
		if !validTarget {
			report.remove(path, "rule target is neither a template group nor a Mihomo built-in policy")
			continue
		}
		if ruleType == "MATCH" || ruleType == "FINAL" {
			hasFallback = true
		}
		clean = append(clean, rule)
	}
	if len(clean) == 0 {
		return errors.New("template has no usable rules")
	}
	if !hasFallback {
		return errors.New("template requires an explicit MATCH or FINAL fallback rule")
	}
	lastFields := splitRuleFields(nonEmptyString(clean[len(clean)-1]))
	lastType := ""
	if len(lastFields) > 0 {
		lastType = strings.ToUpper(lastFields[0])
	}
	if lastType != "MATCH" && lastType != "FINAL" {
		return errors.New("the MATCH or FINAL fallback rule must be the final ordered rule")
	}
	for name := range providers {
		if !providerUse[name] {
			report.Warnings = append(report.Warnings, fmt.Sprintf("rule provider %q is not referenced by any rule", name))
		}
	}
	document["rules"] = clean
	return nil
}

func sanitizeTemplateDocument(input map[string]any) (map[string]any, templateSanitizeReport, error) {
	document := cloneMap(input)
	report := templateSanitizeReport{
		Removed:  make([]templateChange, 0),
		Adjusted: make([]templateChange, 0),
		Warnings: make([]string, 0),
	}
	for key := range document {
		if !allowedTemplateTopLevel[key] {
			delete(document, key)
			reason := "not part of the portable PARTY policy contract"
			if key == "proxies" || key == "proxy-providers" {
				reason = "proxy nodes and credentials are supplied by the active source"
			}
			report.remove(key, reason)
		}
	}
	sanitizeTemplateDNS(document, &report)
	providers := sanitizeRuleProviders(document, &report)
	groups, err := sanitizeProxyGroups(document, &report)
	if err != nil {
		return nil, report, err
	}
	if len(groups) == 0 {
		return nil, report, errors.New("template has no proxy groups")
	}
	sanitizeProviderTargets(document, groups, &report)
	if err := sanitizeRules(document, groups, providers, &report); err != nil {
		return nil, report, err
	}
	if err := validateTemplate(document); err != nil {
		return nil, report, err
	}
	return document, report, nil
}

func canonicalTemplateYAML(document map[string]any) ([]byte, error) {
	body, err := yaml.Marshal(document)
	if err != nil {
		return nil, err
	}
	header := []byte("# Managed by SSClash PARTY Templates. Router Integration settings and proxy nodes are applied separately.\n")
	return append(header, body...), nil
}

func prepareTemplate(path string) (templatePrepared, error) {
	document, original, err := readYAML(path)
	if err != nil {
		return templatePrepared{}, err
	}
	sanitized, report, err := sanitizeTemplateDocument(document)
	if err != nil {
		return templatePrepared{}, err
	}
	canonical, err := canonicalTemplateYAML(sanitized)
	if err != nil {
		return templatePrepared{}, err
	}
	changed := len(report.Removed) > 0 || len(report.Adjusted) > 0 || string(original) != string(canonical)
	return templatePrepared{
		OK: true, Changed: changed, YAML: string(canonical), Document: sanitized,
		Summary: templateSummaryFor(sanitized), Report: report,
	}, nil
}

func readBuiltinCatalog(directory string) (builtinCatalog, error) {
	data, err := os.ReadFile(filepath.Join(directory, "catalog.json"))
	if err != nil {
		return builtinCatalog{}, err
	}
	var catalog builtinCatalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		return builtinCatalog{}, err
	}
	return catalog, nil
}

func readTemplateMetadata(path string) (templateMetadata, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return templateMetadata{}, err
	}
	var metadata templateMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return templateMetadata{}, err
	}
	if !templateIDPattern.MatchString(metadata.ID) || metadata.Revision < 1 {
		return templateMetadata{}, errors.New("custom template metadata is invalid")
	}
	return metadata, nil
}

func readTemplateRecord(builtinDir, customDir, id string, content bool) (templateRecord, error) {
	if !templateIDPattern.MatchString(id) {
		return templateRecord{}, errors.New("template ID is invalid")
	}
	catalog, _ := readBuiltinCatalog(builtinDir)
	for _, item := range catalog.Templates {
		if item.ID != id {
			continue
		}
		path := filepath.Join(builtinDir, id+".yaml")
		document, data, err := readYAML(path)
		if err != nil {
			return templateRecord{}, err
		}
		if err := validateTemplate(document); err != nil {
			return templateRecord{}, err
		}
		record := templateRecord{
			templateMetadata: templateMetadata{ID: id, Name: item.Name, Description: item.Description},
			Source:           "builtin", ReadOnly: true, Version: item.Version, Summary: templateSummaryFor(document),
		}
		if content {
			record.YAML, record.Document = string(data), document
		}
		return record, nil
	}

	directory := filepath.Join(customDir, id)
	metadata, err := readTemplateMetadata(filepath.Join(directory, "metadata.json"))
	if err != nil {
		return templateRecord{}, err
	}
	if metadata.ID != id {
		return templateRecord{}, errors.New("custom template directory does not match metadata")
	}
	document, data, err := readYAML(filepath.Join(directory, "template.yaml"))
	if err != nil {
		return templateRecord{}, err
	}
	if err := validateTemplate(document); err != nil {
		return templateRecord{}, err
	}
	record := templateRecord{
		templateMetadata: metadata, Source: "custom", ReadOnly: false, Summary: templateSummaryFor(document),
	}
	entries, _ := os.ReadDir(filepath.Join(directory, "history"))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
			continue
		}
		revision, parseErr := strconv.Atoi(strings.TrimSuffix(entry.Name(), ".yaml"))
		if parseErr == nil && revision > 0 {
			record.History = append(record.History, revision)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(record.History)))
	if content {
		record.YAML, record.Document = string(data), document
	}
	return record, nil
}

func listTemplates(builtinDir, customDir, legacyDir string) (templateCatalogResponse, error) {
	response := templateCatalogResponse{SchemaVersion: 2, Templates: make([]templateRecord, 0), LegacyLists: make([]legacyTemplateList, 0)}
	catalog, err := readBuiltinCatalog(builtinDir)
	if err != nil {
		return response, err
	}
	for _, item := range catalog.Templates {
		record, recordErr := readTemplateRecord(builtinDir, customDir, item.ID, false)
		if recordErr != nil {
			return response, recordErr
		}
		response.Templates = append(response.Templates, record)
	}
	entries, _ := os.ReadDir(customDir)
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") || !templateIDPattern.MatchString(entry.Name()) {
			continue
		}
		record, recordErr := readTemplateRecord(builtinDir, customDir, entry.Name(), false)
		if recordErr != nil {
			continue
		}
		response.Templates = append(response.Templates, record)
	}
	sort.SliceStable(response.Templates, func(left, right int) bool {
		if response.Templates[left].Source != response.Templates[right].Source {
			return response.Templates[left].Source == "builtin"
		}
		return strings.ToLower(response.Templates[left].Name) < strings.ToLower(response.Templates[right].Name)
	})
	legacyEntries, _ := os.ReadDir(legacyDir)
	for _, entry := range legacyEntries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".txt") || entry.Name() == "fakeip-whitelist-ipcidr.txt" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(legacyDir, entry.Name()))
		if readErr != nil {
			continue
		}
		count := 0
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line != "" && !strings.HasPrefix(line, "#") {
				count++
			}
		}
		response.LegacyLists = append(response.LegacyLists, legacyTemplateList{Name: entry.Name(), Entries: count})
	}
	sort.Slice(response.LegacyLists, func(left, right int) bool { return response.LegacyLists[left].Name < response.LegacyLists[right].Name })
	trash, _ := os.ReadDir(filepath.Join(customDir, ".trash"))
	response.TrashCount = len(trash)
	return response, nil
}

func withTemplateStoreLock(customDir string, operation func() error) error {
	if err := os.MkdirAll(customDir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(customDir, 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(customDir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = lock.Close() }()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()
	return operation()
}

func copyFile(source, target string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { _ = input.Close() }()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func pruneTemplateHistory(directory string) {
	entries, _ := os.ReadDir(directory)
	revisions := make([]int, 0)
	for _, entry := range entries {
		revision, err := strconv.Atoi(strings.TrimSuffix(entry.Name(), ".yaml"))
		if err == nil && strings.HasSuffix(entry.Name(), ".yaml") {
			revisions = append(revisions, revision)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(revisions)))
	if len(revisions) <= maxTemplateHistory {
		return
	}
	for _, revision := range revisions[maxTemplateHistory:] {
		_ = os.Remove(filepath.Join(directory, fmt.Sprintf("%d.yaml", revision)))
	}
}

func validateTemplateWithMihomo(document map[string]any, binary string) error {
	if binary == "" {
		return nil
	}
	info, err := os.Stat(binary)
	if err != nil || info.Mode()&0o111 == 0 {
		return errors.New("mihomo validation binary is unavailable")
	}
	directory, err := os.MkdirTemp("", "ssclash-template-test.")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(directory) }()
	candidate := cloneMap(document)
	candidate["proxies"] = []any{map[string]any{
		"name": "PARTY-TEMPLATE-CHECK", "type": "socks5", "server": "127.0.0.1", "port": 1,
	}}
	if _, err := normalizeProviderCaches(candidate, ""); err != nil {
		return fmt.Errorf("prepare provider caches for Mihomo validation: %w", err)
	}
	body, err := yaml.Marshal(candidate)
	if err != nil {
		return err
	}
	path := filepath.Join(directory, "config.yaml")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		return err
	}
	command := exec.Command(binary, "-t", "-d", directory, "-f", path)
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if len(message) > 2048 {
			message = message[len(message)-2048:]
		}
		return fmt.Errorf("mihomo rejected the template: %s", message)
	}
	return nil
}

func saveCustomTemplate(builtinDir, customDir, id, name, description, inputPath string, expectedRevision int, mihomo string) (templateRecord, error) {
	if !templateIDPattern.MatchString(id) {
		return templateRecord{}, errors.New("template ID is invalid")
	}
	name, err := safeTemplateText(name, maxTemplateNameLength, "template name")
	if err != nil {
		return templateRecord{}, err
	}
	description = strings.TrimSpace(description)
	if len(description) > maxTemplateDescriptionLength {
		return templateRecord{}, fmt.Errorf("template description exceeds %d bytes", maxTemplateDescriptionLength)
	}
	for _, character := range description {
		if unicode.IsControl(character) && character != '\t' && character != '\n' {
			return templateRecord{}, errors.New("template description contains control characters")
		}
	}
	if builtin, _ := readBuiltinCatalog(builtinDir); len(builtin.Templates) > 0 {
		for _, item := range builtin.Templates {
			if item.ID == id {
				return templateRecord{}, errors.New("built-in templates are immutable; clone to a new ID")
			}
		}
	}
	prepared, err := prepareTemplate(inputPath)
	if err != nil {
		return templateRecord{}, err
	}
	if err := validateTemplateWithMihomo(prepared.Document, mihomo); err != nil {
		return templateRecord{}, err
	}

	err = withTemplateStoreLock(customDir, func() error {
		target := filepath.Join(customDir, id)
		currentRevision := 0
		var current templateMetadata
		if existing, readErr := readTemplateMetadata(filepath.Join(target, "metadata.json")); readErr == nil {
			current = existing
			currentRevision = existing.Revision
		} else if !os.IsNotExist(readErr) {
			return readErr
		}
		if currentRevision != expectedRevision {
			return fmt.Errorf("template revision conflict: expected %d, current %d", expectedRevision, currentRevision)
		}
		now := time.Now().UTC().Format(time.RFC3339)
		created := current.CreatedAt
		if created == "" {
			created = now
		}
		metadata := templateMetadata{
			ID: id, Name: name, Description: description, Revision: currentRevision + 1,
			CreatedAt: created, UpdatedAt: now,
		}
		staging, stageErr := os.MkdirTemp(customDir, ".staging-"+id+".")
		if stageErr != nil {
			return stageErr
		}
		defer func() { _ = os.RemoveAll(staging) }()
		if stageErr = os.Chmod(staging, 0o700); stageErr != nil {
			return stageErr
		}
		history := filepath.Join(staging, "history")
		if stageErr = os.Mkdir(history, 0o700); stageErr != nil {
			return stageErr
		}
		if currentRevision > 0 {
			oldHistory, _ := os.ReadDir(filepath.Join(target, "history"))
			for _, entry := range oldHistory {
				if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
					continue
				}
				if stageErr = copyFile(filepath.Join(target, "history", entry.Name()), filepath.Join(history, entry.Name()), 0o600); stageErr != nil {
					return stageErr
				}
			}
			if stageErr = copyFile(filepath.Join(target, "template.yaml"), filepath.Join(history, fmt.Sprintf("%d.yaml", currentRevision)), 0o600); stageErr != nil {
				return stageErr
			}
		}
		pruneTemplateHistory(history)
		if stageErr = os.WriteFile(filepath.Join(staging, "template.yaml"), []byte(prepared.YAML), 0o600); stageErr != nil {
			return stageErr
		}
		metadataBytes, _ := json.MarshalIndent(metadata, "", "  ")
		metadataBytes = append(metadataBytes, '\n')
		if stageErr = os.WriteFile(filepath.Join(staging, "metadata.json"), metadataBytes, 0o600); stageErr != nil {
			return stageErr
		}
		previous := filepath.Join(customDir, fmt.Sprintf(".previous-%s-%d", id, time.Now().UnixNano()))
		if currentRevision > 0 {
			if stageErr = os.Rename(target, previous); stageErr != nil {
				return stageErr
			}
		}
		if stageErr = os.Rename(staging, target); stageErr != nil {
			if currentRevision > 0 {
				_ = os.Rename(previous, target)
			}
			return stageErr
		}
		if currentRevision > 0 {
			_ = os.RemoveAll(previous)
		}
		return nil
	})
	if err != nil {
		return templateRecord{}, err
	}
	return readTemplateRecord(builtinDir, customDir, id, true)
}

func deleteCustomTemplate(builtinDir, customDir, id string, expectedRevision int) error {
	if !templateIDPattern.MatchString(id) {
		return errors.New("template ID is invalid")
	}
	if record, err := readTemplateRecord(builtinDir, customDir, id, false); err == nil && record.ReadOnly {
		return errors.New("built-in templates cannot be deleted")
	}
	return withTemplateStoreLock(customDir, func() error {
		target := filepath.Join(customDir, id)
		metadata, err := readTemplateMetadata(filepath.Join(target, "metadata.json"))
		if err != nil {
			return err
		}
		if metadata.Revision != expectedRevision {
			return fmt.Errorf("template revision conflict: expected %d, current %d", expectedRevision, metadata.Revision)
		}
		trash := filepath.Join(customDir, ".trash")
		if err := os.MkdirAll(trash, 0o700); err != nil {
			return err
		}
		destination := filepath.Join(trash, fmt.Sprintf("%s-%s-r%d", id, time.Now().UTC().Format("20060102T150405Z"), metadata.Revision))
		return os.Rename(target, destination)
	})
}

func restoreCustomTemplate(builtinDir, customDir, id string, revision, expectedRevision int, mihomo string) (templateRecord, error) {
	record, err := readTemplateRecord(builtinDir, customDir, id, false)
	if err != nil {
		return templateRecord{}, err
	}
	if record.ReadOnly || record.Revision != expectedRevision {
		return templateRecord{}, errors.New("template revision conflict or immutable template")
	}
	path := filepath.Join(customDir, id, "history", fmt.Sprintf("%d.yaml", revision))
	if _, err := os.Stat(path); err != nil {
		return templateRecord{}, errors.New("requested template history revision is unavailable")
	}
	return saveCustomTemplate(builtinDir, customDir, id, record.Name, record.Description, path, expectedRevision, mihomo)
}

func writeTemplateJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func runTemplateCommand(arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("template operation is required")
	}
	operation := arguments[0]
	flags := flag.NewFlagSet("template "+operation, flag.ContinueOnError)
	builtinDir := flags.String("builtin-dir", "/usr/share/ssclash-party/templates", "built-in template directory")
	customDir := flags.String("custom-dir", "/etc/ssclash-party/templates", "custom template directory")
	legacyDir := flags.String("legacy-dir", "/opt/clash/lst", "legacy list directory")
	id := flags.String("id", "", "template ID")
	name := flags.String("name", "", "template display name")
	description := flags.String("description", "", "template description")
	input := flags.String("input", "", "input YAML or JSON file")
	expected := flags.Int("expected-revision", -1, "optimistic current revision")
	revision := flags.Int("revision", 0, "history revision")
	mihomo := flags.String("mihomo", "", "Mihomo binary for final validation")
	if err := flags.Parse(arguments[1:]); err != nil {
		return err
	}
	switch operation {
	case "list":
		response, err := listTemplates(*builtinDir, *customDir, *legacyDir)
		if err != nil {
			return err
		}
		return writeTemplateJSON(response)
	case "get":
		record, err := readTemplateRecord(*builtinDir, *customDir, *id, true)
		if err != nil {
			return err
		}
		return writeTemplateJSON(record)
	case "prepare":
		if *input == "" {
			return errors.New("-input is required")
		}
		prepared, err := prepareTemplate(*input)
		if err != nil {
			return err
		}
		return writeTemplateJSON(prepared)
	case "save":
		if *input == "" || *expected < 0 {
			return errors.New("-input and a non-negative -expected-revision are required")
		}
		record, err := saveCustomTemplate(*builtinDir, *customDir, *id, *name, *description, *input, *expected, *mihomo)
		if err != nil {
			return err
		}
		return writeTemplateJSON(record)
	case "delete":
		if *expected < 1 {
			return errors.New("a positive -expected-revision is required")
		}
		if err := deleteCustomTemplate(*builtinDir, *customDir, *id, *expected); err != nil {
			return err
		}
		return writeTemplateJSON(map[string]any{"ok": true, "recoverable": true})
	case "restore":
		if *revision < 1 || *expected < 1 {
			return errors.New("positive -revision and -expected-revision values are required")
		}
		record, err := restoreCustomTemplate(*builtinDir, *customDir, *id, *revision, *expected, *mihomo)
		if err != nil {
			return err
		}
		return writeTemplateJSON(record)
	default:
		return fmt.Errorf("unknown template operation %q", operation)
	}
}
