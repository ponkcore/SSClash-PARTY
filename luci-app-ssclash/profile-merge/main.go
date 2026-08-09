package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	defaultDNSListen   = "127.0.0.1:7874"
	defaultTProxyPort  = 7894
	defaultRoutingMark = 2
	maxYAMLSize        = 5 * 1024 * 1024
)

var unsafeTopLevelKeys = []string{
	"authentication",
	"bind-address",
	"external-controller-cors",
	"external-controller-pipe",
	"external-controller-tls",
	"external-controller-unix",
	"external-doh-server",
	"inbounds",
	"interface-name",
	"lan-allowed-ips",
	"lan-disallowed-ips",
	"listeners",
	"mixed-port",
	"port",
	"redir-port",
	"skip-auth-prefixes",
	"socks-port",
	"tls",
	"tun",
}

type routerPolicy struct {
	Controller               string
	ControllerSecret         string
	DNSListen                string
	DNSMode                  string
	FakeIPRange              string
	FakeIPFilterMode         string
	FakeIPFilter             []string
	StoreFakeIP              bool
	TProxyPort               int
	RoutingMark              int
	ProxyMode                string
	TunStack                 string
	IPv6                     bool
	PanelHostname            string
	TrustedLocalProviderPath string
}

type mergeSummary struct {
	InlineProxies             int      `json:"inline_proxies"`
	ProxyProviders            int      `json:"proxy_providers"`
	ProxyGroups               int      `json:"proxy_groups"`
	RuleProviders             int      `json:"rule_providers"`
	Rules                     int      `json:"rules"`
	DNSMode                   string   `json:"dns_mode"`
	ProxyMode                 string   `json:"proxy_mode"`
	SourceSHA256              string   `json:"source_sha256"`
	OutputSHA256              string   `json:"output_sha256"`
	GeneratedControllerSecret bool     `json:"generated_controller_secret"`
	RuntimeRestartRequired    bool     `json:"runtime_restart_required"`
	NormalizedGroups          []string `json:"normalized_provider_groups,omitempty"`
	NormalizedCaches          int      `json:"normalized_provider_cache_paths"`
	SourceFormat              string   `json:"source_format,omitempty"`
	RulesSource               string   `json:"rules_source,omitempty"`
	TemplateID                string   `json:"template_id,omitempty"`
	InputLinks                int      `json:"input_links,omitempty"`
	SkippedLines              int      `json:"skipped_lines,omitempty"`
}

type repeatedStringFlag []string

func (values *repeatedStringFlag) String() string {
	return strings.Join(*values, ",")
}

func (values *repeatedStringFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func readYAML(path string) (map[string]any, []byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if info.Size() <= 0 {
		return nil, nil, fmt.Errorf("%s is empty", path)
	}
	if info.Size() > maxYAMLSize {
		return nil, nil, fmt.Errorf("%s exceeds the %d-byte limit", path, maxYAMLSize)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}

	var document map[string]any
	if err := yaml.Unmarshal(data, &document); err != nil {
		return nil, nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if document == nil {
		return nil, nil, fmt.Errorf("%s has no YAML mapping", path)
	}
	return document, data, nil
}

func asMap(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func asSlice(value any) []any {
	result, _ := value.([]any)
	return result
}

func nonEmptyString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func cloneMap(source map[string]any) map[string]any {
	result := make(map[string]any, len(source))
	for key, value := range source {
		switch typed := value.(type) {
		case map[string]any:
			result[key] = cloneMap(typed)
		case []any:
			result[key] = cloneSlice(typed)
		default:
			result[key] = value
		}
	}
	return result
}

func cloneSlice(source []any) []any {
	result := make([]any, len(source))
	for index, value := range source {
		switch typed := value.(type) {
		case map[string]any:
			result[index] = cloneMap(typed)
		case []any:
			result[index] = cloneSlice(typed)
		default:
			result[index] = value
		}
	}
	return result
}

func providerNames(document map[string]any) []string {
	providers := asMap(document["proxy-providers"])
	names := make([]string, 0, len(providers))
	for name := range providers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func stringSlice(value any) []string {
	items := asSlice(value)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text := nonEmptyString(item); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func mergeUnique(left, right []string) []any {
	seen := make(map[string]bool, len(left)+len(right))
	result := make([]any, 0, len(left)+len(right))
	for _, item := range append(left, right...) {
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		result = append(result, item)
	}
	return result
}

func normalizeProviderGroups(document map[string]any) []string {
	providers := providerNames(document)
	if len(providers) == 0 {
		return nil
	}

	hasInlineProxies := len(asSlice(document["proxies"])) > 0
	groups := asSlice(document["proxy-groups"])
	normalized := make([]string, 0)

	for _, item := range groups {
		group := asMap(item)
		if group == nil {
			continue
		}
		includeAll, _ := group["include-all"].(bool)
		if !includeAll {
			continue
		}

		delete(group, "include-all")
		group["use"] = mergeUnique(stringSlice(group["use"]), providers)
		if hasInlineProxies {
			group["include-all-proxies"] = true
		}
		normalized = append(normalized, nonEmptyString(group["name"]))
	}

	return normalized
}

func providerCacheExtension(provider map[string]any) string {
	switch strings.ToLower(nonEmptyString(provider["format"])) {
	case "mrs":
		return ".mrs"
	case "text":
		return ".txt"
	default:
		return ".yaml"
	}
}

func providerCacheName(section, name string) string {
	sum := sha256.Sum256([]byte(section + "\x00" + name))
	return hex.EncodeToString(sum[:8])
}

func normalizeProviderCaches(document map[string]any, trustedLocalProviderPath string) (int, error) {
	normalized := 0
	for _, section := range []string{"proxy-providers", "rule-providers"} {
		providers := asMap(document[section])
		for name, item := range providers {
			provider := asMap(item)
			if provider == nil {
				return 0, fmt.Errorf("%s %q is not a mapping", section, name)
			}

			switch strings.ToLower(nonEmptyString(provider["type"])) {
			case "http":
				kind := "proxies"
				if section == "rule-providers" {
					kind = "rules"
				}
				provider["path"] = fmt.Sprintf(
					"./managed-providers/%s/%s%s",
					kind,
					providerCacheName(section, name),
					providerCacheExtension(provider),
				)
				normalized++
			case "inline":
				delete(provider, "path")
			case "file":
				if section == "proxy-providers" &&
					name == localProviderName &&
					nonEmptyString(provider["path"]) == trustedLocalProviderPath &&
					validManagedSourcePath(trustedLocalProviderPath) {
					continue
				}
				return 0, fmt.Errorf(
					"%s %q uses a local file; managed remote profiles must be self-contained",
					section,
					name,
				)
			default:
				return 0, fmt.Errorf("%s %q has an unsupported provider type", section, name)
			}
		}
	}
	return normalized, nil
}

func validateRemote(document map[string]any) error {
	proxyCount := len(asSlice(document["proxies"]))
	providerCount := len(asMap(document["proxy-providers"]))
	if proxyCount == 0 && providerCount == 0 {
		return errors.New("remote profile contains neither inline proxies nor proxy providers")
	}
	if len(asSlice(document["proxy-groups"])) == 0 {
		return errors.New("remote profile has no proxy-groups")
	}
	if len(asSlice(document["rules"])) == 0 {
		return errors.New("remote profile has no rules")
	}
	return nil
}

func splitIPPort(address string) (net.IP, int, error) {
	host, portText, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil {
		return nil, 0, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return nil, 0, errors.New("port is outside the valid range")
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil, 0, errors.New("host must be an IP address")
	}
	return ip, port, nil
}

func validateController(address string) error {
	ip, _, err := splitIPPort(address)
	if err != nil {
		return fmt.Errorf("invalid controller address %q: %w", address, err)
	}
	if ip.IsUnspecified() {
		return errors.New("controller must not bind to an unspecified address")
	}
	if !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
		return errors.New("controller must bind to a private, loopback, or link-local address")
	}
	return nil
}

func validateDNSListen(address string) error {
	ip, _, err := splitIPPort(address)
	if err != nil {
		return fmt.Errorf("invalid DNS listener %q: %w", address, err)
	}
	if !ip.IsLoopback() {
		return errors.New("managed DNS must bind to a loopback address")
	}
	return nil
}

func selectController(current map[string]any, override string) (string, error) {
	controller := strings.TrimSpace(override)
	if controller == "" {
		controller = nonEmptyString(current["external-controller"])
	}
	if controller == "" {
		return "", errors.New("a private controller address is required")
	}
	if err := validateController(controller); err != nil {
		return "", err
	}
	return controller, nil
}

func safeControllerSecret(secret string) bool {
	if len(secret) == 0 || len(secret) > 512 {
		return false
	}
	for _, character := range secret {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case strings.ContainsRune("._~-", character):
		default:
			return false
		}
	}
	return true
}

func controllerSecret(current map[string]any, override string) (string, bool, error) {
	if strings.TrimSpace(override) != "" {
		if !safeControllerSecret(override) {
			return "", false, errors.New("the configured controller secret contains unsupported characters")
		}
		return override, false, nil
	}
	if secret := nonEmptyString(current["secret"]); safeControllerSecret(secret) {
		return secret, false, nil
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", false, fmt.Errorf("generate controller secret: %w", err)
	}
	return hex.EncodeToString(random), true, nil
}

func validFakeIPFilter(filters []string) error {
	if len(filters) == 0 || len(filters) > 256 {
		return errors.New("fake-ip mode requires between 1 and 256 compatibility filters")
	}
	for _, filter := range filters {
		if strings.TrimSpace(filter) == "" || len(filter) > 255 || strings.ContainsAny(filter, "\r\n\x00") {
			return errors.New("a fake-ip compatibility filter is empty or invalid")
		}
	}
	return nil
}

func validateFakeIPRange(value string) error {
	ip, network, err := net.ParseCIDR(strings.TrimSpace(value))
	if err != nil || ip.To4() == nil {
		return errors.New("fake-ip range must be a valid IPv4 CIDR")
	}
	ones, bits := network.Mask.Size()
	if bits != 32 || ones < 8 || ones > 24 {
		return errors.New("fake-ip range prefix must be between /8 and /24")
	}
	if network.IP.IsUnspecified() || network.IP.IsLoopback() || network.IP.IsMulticast() {
		return errors.New("fake-ip range must not use unspecified, loopback, or multicast space")
	}
	return nil
}

func copyProtectedDNSMode(dns, currentDNS map[string]any, policy routerPolicy) error {
	protectedKeys := []string{
		"enhanced-mode",
		"fake-ip-range",
		"fake-ip-filter",
		"fake-ip-filter-mode",
	}
	for _, key := range protectedKeys {
		delete(dns, key)
	}

	switch policy.DNSMode {
	case "", "preserve":
		for _, key := range protectedKeys {
			if value, exists := currentDNS[key]; exists {
				dns[key] = value
			}
		}
	case "redir-host":
		dns["enhanced-mode"] = "redir-host"
	case "fake-ip":
		if err := validateFakeIPRange(policy.FakeIPRange); err != nil {
			return err
		}
		if policy.FakeIPFilterMode != "blacklist" && policy.FakeIPFilterMode != "whitelist" {
			return errors.New("fake-ip filter mode must be blacklist or whitelist")
		}
		if err := validFakeIPFilter(policy.FakeIPFilter); err != nil {
			return err
		}
		dns["enhanced-mode"] = "fake-ip"
		dns["fake-ip-range"] = policy.FakeIPRange
		dns["fake-ip-filter-mode"] = policy.FakeIPFilterMode
		filters := make([]any, 0, len(policy.FakeIPFilter))
		for _, filter := range policy.FakeIPFilter {
			filters = append(filters, strings.TrimSpace(filter))
		}
		dns["fake-ip-filter"] = filters
	default:
		return fmt.Errorf("unsupported protected DNS mode %q", policy.DNSMode)
	}
	return nil
}

func copyProtectedProfileSettings(result, current map[string]any, policy routerPolicy) {
	profile := asMap(result["profile"])
	if profile == nil {
		profile = make(map[string]any)
	}
	currentProfile := asMap(current["profile"])

	delete(profile, "store-fake-ip")
	if policy.DNSMode == "fake-ip" {
		profile["store-fake-ip"] = policy.StoreFakeIP
	} else if currentProfile != nil {
		if value, exists := currentProfile["store-fake-ip"]; exists {
			profile["store-fake-ip"] = value
		}
	}

	if len(profile) == 0 {
		delete(result, "profile")
	} else {
		result["profile"] = profile
	}
}

var localHostnamePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)

func validatePanelHostname(hostname string) error {
	if hostname == "" {
		return nil
	}
	if len(hostname) > 253 || !localHostnamePattern.MatchString(hostname) || strings.Contains(hostname, "..") {
		return errors.New("panel hostname is invalid")
	}
	if ip := net.ParseIP(hostname); ip != nil {
		return errors.New("panel hostname must be a DNS name rather than an IP address")
	}
	return nil
}

func controllerCORS(controller, panelHostname string) (map[string]any, error) {
	panelHostname = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(panelHostname), "."))
	if panelHostname != "" {
		if err := validatePanelHostname(panelHostname); err != nil {
			return nil, err
		}
	}
	ip, _, err := splitIPPort(controller)
	if err != nil {
		return nil, err
	}
	hosts := []string{ip.String()}
	if panelHostname != "" {
		hosts = append([]string{panelHostname}, hosts...)
	}
	origins := make([]any, 0, len(hosts)*2)
	seen := make(map[string]bool)
	for _, host := range hosts {
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		for _, scheme := range []string{"http", "https"} {
			origin := scheme + "://" + host
			parsed, parseErr := url.Parse(origin)
			if parseErr != nil || parsed.Hostname() == "" || parsed.Path != "" {
				return nil, errors.New("failed to construct a safe controller CORS origin")
			}
			if !seen[origin] {
				seen[origin] = true
				origins = append(origins, origin)
			}
		}
	}
	return map[string]any{
		"allow-origins":         origins,
		"allow-private-network": true,
	}, nil
}

func normalizeRouterPolicy(policy routerPolicy) (routerPolicy, error) {
	if policy.TProxyPort == 0 {
		policy.TProxyPort = defaultTProxyPort
	}
	if policy.TProxyPort < 1 || policy.TProxyPort > 65535 {
		return policy, errors.New("TPROXY port is outside the valid range")
	}
	if policy.RoutingMark == 0 {
		policy.RoutingMark = defaultRoutingMark
	}
	if policy.RoutingMark < 1 || policy.RoutingMark > 65535 || policy.RoutingMark == 1 || policy.RoutingMark == 3 {
		return policy, errors.New("routing mark must be 2 or an integer from 4 through 65535")
	}
	if policy.ProxyMode == "" {
		policy.ProxyMode = "tproxy"
	}
	if policy.ProxyMode != "tproxy" && policy.ProxyMode != "tun" && policy.ProxyMode != "mixed" {
		return policy, errors.New("proxy mode must be tproxy, tun, or mixed")
	}
	if policy.TunStack == "" {
		policy.TunStack = "system"
	}
	if policy.TunStack != "system" && policy.TunStack != "gvisor" && policy.TunStack != "mixed" {
		return policy, errors.New("TUN stack must be system, gvisor, or mixed")
	}
	return policy, nil
}

func runtimeSignature(document map[string]any) map[string]any {
	signature := make(map[string]any)
	keys := append([]string{
		"allow-lan",
		"external-controller",
		"find-process-mode",
		"ipv6",
		"routing-mark",
		"secret",
		"tproxy-port",
	}, unsafeTopLevelKeys...)
	for _, key := range keys {
		if value, exists := document[key]; exists {
			signature[key] = value
		}
	}

	dns := asMap(document["dns"])
	if dns != nil {
		protectedDNS := make(map[string]any)
		for _, key := range []string{
			"enhanced-mode",
			"fake-ip-filter",
			"fake-ip-filter-mode",
			"fake-ip-range",
			"listen",
		} {
			if value, exists := dns[key]; exists {
				protectedDNS[key] = value
			}
		}
		signature["dns"] = protectedDNS
	}
	return signature
}

func runtimeRestartRequired(current, result map[string]any) bool {
	return !reflect.DeepEqual(runtimeSignature(current), runtimeSignature(result))
}

func overlayRouterSettings(remote, current map[string]any, policy routerPolicy) (map[string]any, []string, int, bool, error) {
	var err error
	policy, err = normalizeRouterPolicy(policy)
	if err != nil {
		return nil, nil, 0, false, err
	}
	if err := validateRemote(remote); err != nil {
		return nil, nil, 0, false, err
	}

	controller, err := selectController(current, policy.Controller)
	if err != nil {
		return nil, nil, 0, false, err
	}
	secret, generatedSecret, err := controllerSecret(current, policy.ControllerSecret)
	if err != nil {
		return nil, nil, 0, false, err
	}

	dnsListen := strings.TrimSpace(policy.DNSListen)
	if dnsListen == "" {
		dnsListen = nonEmptyString(asMap(current["dns"])["listen"])
	}
	if dnsListen == "" {
		dnsListen = defaultDNSListen
	}
	if err := validateDNSListen(dnsListen); err != nil {
		return nil, nil, 0, false, err
	}
	_, controllerPort, _ := splitIPPort(controller)
	_, dnsPort, _ := splitIPPort(dnsListen)
	if controllerPort == dnsPort {
		return nil, nil, 0, false, errors.New("controller and DNS listener ports must be different")
	}
	if (policy.ProxyMode == "tproxy" || policy.ProxyMode == "mixed") &&
		(policy.TProxyPort == controllerPort || policy.TProxyPort == dnsPort) {
		return nil, nil, 0, false, errors.New("TPROXY, controller, and DNS listener ports must be different")
	}

	result := cloneMap(remote)
	for _, key := range unsafeTopLevelKeys {
		delete(result, key)
	}

	result["mode"] = "rule"
	result["find-process-mode"] = "off"
	delete(result, "tproxy-port")
	if policy.ProxyMode == "tproxy" || policy.ProxyMode == "mixed" {
		result["tproxy-port"] = policy.TProxyPort
	}
	if policy.ProxyMode == "tun" || policy.ProxyMode == "mixed" {
		result["tun"] = map[string]any{
			"enable":                true,
			"device":                "clash-tun",
			"stack":                 policy.TunStack,
			"auto-route":            false,
			"auto-redirect":         false,
			"auto-detect-interface": false,
		}
	}
	result["ipv6"] = policy.IPv6
	result["allow-lan"] = false
	result["routing-mark"] = policy.RoutingMark
	result["external-controller"] = controller
	result["secret"] = secret
	result["external-ui"] = "./ui"
	delete(result, "external-ui-url")
	delete(result, "external-ui-name")
	controllerCORSSettings, err := controllerCORS(controller, policy.PanelHostname)
	if err != nil {
		return nil, nil, 0, false, err
	}
	if controllerCORSSettings != nil {
		result["external-controller-cors"] = controllerCORSSettings
	}

	if logLevel := nonEmptyString(current["log-level"]); logLevel != "" {
		result["log-level"] = logLevel
	}

	dns := asMap(result["dns"])
	if dns == nil {
		dns = cloneMap(asMap(current["dns"]))
	}
	if dns == nil {
		dns = make(map[string]any)
	}
	currentDNS := asMap(current["dns"])
	if currentDNS == nil {
		currentDNS = make(map[string]any)
	}
	dns["enable"] = true
	dns["listen"] = dnsListen
	dns["ipv6"] = policy.IPv6
	if err := copyProtectedDNSMode(dns, currentDNS, policy); err != nil {
		return nil, nil, 0, false, err
	}
	result["dns"] = dns
	copyProtectedProfileSettings(result, current, policy)

	normalizedCaches, err := normalizeProviderCaches(result, policy.TrustedLocalProviderPath)
	if err != nil {
		return nil, nil, 0, false, err
	}
	normalized := normalizeProviderGroups(result)
	return result, normalized, normalizedCaches, generatedSecret, nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func countMap(value any) int {
	return len(asMap(value))
}

func dnsMode(document map[string]any) string {
	dns := asMap(document["dns"])
	if dns == nil {
		return "absent"
	}
	if mode := nonEmptyString(dns["enhanced-mode"]); mode != "" {
		return mode
	}
	return "redir-host"
}

func writeOutput(path string, document map[string]any) ([]byte, error) {
	body, err := yaml.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("encode output YAML: %w", err)
	}
	header := []byte("# Generated by ssclash-profile-merge. Do not edit while managed sync is enabled.\n")
	output := append(header, body...)

	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, output, 0o600); err != nil {
		return nil, err
	}
	return output, nil
}

func run(remotePath, currentPath, outputPath string, policy routerPolicy) error {
	remote, remoteBytes, err := readYAML(remotePath)
	if err != nil {
		return err
	}
	current, _, err := readYAML(currentPath)
	if err != nil {
		return err
	}

	policy, err = normalizeRouterPolicy(policy)
	if err != nil {
		return err
	}
	merged, normalized, normalizedCaches, generatedSecret, err := overlayRouterSettings(remote, current, policy)
	if err != nil {
		return err
	}
	outputBytes, err := writeOutput(outputPath, merged)
	if err != nil {
		return err
	}

	summary := mergeSummary{
		InlineProxies:             len(asSlice(merged["proxies"])),
		ProxyProviders:            countMap(merged["proxy-providers"]),
		ProxyGroups:               len(asSlice(merged["proxy-groups"])),
		RuleProviders:             countMap(merged["rule-providers"]),
		Rules:                     len(asSlice(merged["rules"])),
		DNSMode:                   dnsMode(merged),
		ProxyMode:                 policy.ProxyMode,
		SourceSHA256:              sha256Hex(remoteBytes),
		OutputSHA256:              sha256Hex(outputBytes),
		GeneratedControllerSecret: generatedSecret,
		RuntimeRestartRequired:    runtimeRestartRequired(current, merged),
		NormalizedGroups:          normalized,
		NormalizedCaches:          normalizedCaches,
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(summary)
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "inspect":
			if err := runInspectCommand(os.Args[2:]); err != nil {
				fmt.Fprintf(os.Stderr, "ssclash-profile-merge inspect: %v\n", err)
				os.Exit(1)
			}
			return
		case "build":
			if err := runBuildCommand(os.Args[2:]); err != nil {
				fmt.Fprintf(os.Stderr, "ssclash-profile-merge build: %v\n", err)
				os.Exit(1)
			}
			return
		case "template":
			if err := runTemplateCommand(os.Args[2:]); err != nil {
				fmt.Fprintf(os.Stderr, "ssclash-profile-merge template: %v\n", err)
				os.Exit(1)
			}
			return
		}
	}

	var remotePath string
	var currentPath string
	var outputPath string
	var policy routerPolicy
	var fakeIPFilters repeatedStringFlag

	flag.StringVar(&remotePath, "remote", "", "path to the downloaded remote Mihomo YAML")
	flag.StringVar(&currentPath, "current", "", "path to the current router Mihomo YAML")
	flag.StringVar(&outputPath, "output", "", "path for the merged router-safe YAML")
	flag.StringVar(&policy.Controller, "controller", "", "private controller IP and port; defaults to the current config")
	flag.StringVar(&policy.ControllerSecret, "controller-secret", "", "optional protected controller secret")
	flag.StringVar(&policy.DNSListen, "dns-listen", "", "loopback DNS IP and port; defaults to the current config")
	flag.StringVar(&policy.DNSMode, "dns-mode", "preserve", "protected DNS mode: preserve, redir-host, or fake-ip")
	flag.StringVar(&policy.FakeIPRange, "fake-ip-range", "198.18.0.1/16", "protected fake-IP IPv4 range")
	flag.StringVar(&policy.FakeIPFilterMode, "fake-ip-filter-mode", "blacklist", "protected fake-IP filter mode")
	flag.Var(&fakeIPFilters, "fake-ip-filter", "repeatable protected fake-IP compatibility filter")
	flag.BoolVar(&policy.StoreFakeIP, "store-fake-ip", true, "persist fake-IP mappings")
	flag.IntVar(&policy.TProxyPort, "tproxy-port", defaultTProxyPort, "protected TPROXY listener port")
	flag.IntVar(&policy.RoutingMark, "routing-mark", defaultRoutingMark, "protected Mihomo routing mark")
	flag.StringVar(&policy.ProxyMode, "proxy-mode", "tproxy", "protected proxy mode: tproxy, tun, or mixed")
	flag.StringVar(&policy.TunStack, "tun-stack", "system", "protected TUN stack")
	flag.BoolVar(&policy.IPv6, "ipv6", false, "enable protected IPv6 behavior")
	flag.StringVar(&policy.PanelHostname, "panel-hostname", "", "local dashboard DNS hostname")
	flag.Parse()
	policy.FakeIPFilter = []string(fakeIPFilters)

	if remotePath == "" || currentPath == "" || outputPath == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(remotePath, currentPath, outputPath, policy); err != nil {
		fmt.Fprintf(os.Stderr, "ssclash-profile-merge: %v\n", err)
		os.Exit(1)
	}
}
