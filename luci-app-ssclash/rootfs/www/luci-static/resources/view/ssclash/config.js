'use strict';
'require view';
'require fs';
'require rpc';
'require uci';
'require ui';
'require view.ssclash.utils';

let startStopButton = null;
let editor = null;
let managedProfileConfigured = false;

const PROFILE_HELPER = '/usr/libexec/ssclash-profile-sync';
const PROFILE_INIT = '/etc/init.d/ssclash-profile-sync';
const PROFILE_STATUS_FILE = '/tmp/ssclash-profile-sync/status.json';
const LINKS_FILE = '/etc/ssclash-party/links.txt';
const TEMPLATE_CATALOG_FILE = '/usr/share/ssclash-party/templates/catalog.json';
const SSCLASH_MANAGED_PROFILE_UI = '2.0.0';
const LINKS_INLINE_WRITE_MAX = 24576;
const LINKS_BASE64_CHUNK_SIZE = 24000;
const LINKS_MAX_BYTES = 5 * 1024 * 1024;

const callUciCommit = rpc.declare({
    object: 'uci',
    method: 'commit',
    params: [ 'config' ],
    reject: true
});

view_ssclash_utils.bumpRpcTimeout();
try {
    if (L.env && (!(L.env.rpctimeout > 0) || L.env.rpctimeout < 120)) {
        L.env.rpctimeout = 120;
    }
} catch (_e) {}

const getServiceStatus = function() {
    return view_ssclash_utils.getClashRunning();
};

async function dispatchServiceActions(actions) {
    const script = actions.map(function(action) {
        return '/etc/init.d/clash ' + action;
    }).join('; ');
    try {
        await view_ssclash_utils.execDetached(script);
    } catch (e) {
        console.warn('Failed to dispatch clash service action:', e.message);
    }
}

function notifyRestartPending() {
    ui.addNotification(null, E('p',
        _('Service is still restarting — it may take longer on a slow connection. Reload the page in a moment to check its status.')
    ), 'warning');
}

async function toggleService() {
    if (startStopButton) startStopButton.disabled = true;
    try {
        const running = await getServiceStatus();
        const target = !running;
        if (running) {
            await dispatchServiceActions(['stop', 'disable']);
        } else if (managedProfileConfigured) {
            const result = await fs.exec(PROFILE_HELPER, ['sync-start']);
            if (result.code !== 0) {
                const status = parseProfileStatus(result.stdout);
                throw new Error(status.message || _('Managed profile startup failed.'));
            }
        } else {
            await dispatchServiceActions(['start', 'enable']);
        }

        if (await view_ssclash_utils.waitForServiceStatus(getServiceStatus, target)) {
            window.location.reload();
        } else {
            notifyRestartPending();
        }
    } catch (e) {
        ui.addNotification(null, E('p',
            _('Unable to change service state: %s').format(e.message)
        ), 'error');
    } finally {
        if (startStopButton) startStopButton.disabled = false;
    }
}

function parseProfileStatus(text) {
    try {
        const parsed = JSON.parse(String(text || '').trim());
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_e) {
        return {};
    }
}

function profileStatusColor(state) {
    switch (state) {
    case 'success':
        return '#5cb85c';
    case 'working':
        return '#337ab7';
    case 'error':
        return '#d9534f';
    default:
        return '#777';
    }
}

function formatProfileTime(epoch) {
    const value = Number(epoch || 0);
    if (!value) return _('Never');
    try {
        return new Date(value * 1000).toLocaleString();
    } catch (_e) {
        return String(value);
    }
}

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768));
    }
    return { value: btoa(binary), byteLength: bytes.length };
}

function parseYamlValue(yaml, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*${escapedKey}\\s*:\\s*(["\']?)([^#\\r\\n]+?)\\1\\s*(?:#.*)?$`, 'm');
    const m = yaml.match(re);
    return m ? m[2].trim() : null;
}

function normalizeHostPortFromAddr(addr, fallbackHost, fallbackPort) {
    if (!addr) return { host: fallbackHost, port: fallbackPort };
    const cleaned = addr.replace(/["']/g, '').trim();
    let host = fallbackHost, port = fallbackPort;

    if (cleaned.startsWith('[')) {
        const closingBracket = cleaned.indexOf(']');
        if (closingBracket > 0) {
            host = cleaned.slice(1, closingBracket);
            if (cleaned.charAt(closingBracket + 1) === ':') {
                port = cleaned.slice(closingBracket + 2);
            }
        }
    } else {
        const firstColon = cleaned.indexOf(':');
        const lastColon = cleaned.lastIndexOf(':');
        if (firstColon !== -1 && firstColon === lastColon) {
            host = cleaned.slice(0, lastColon);
            port = cleaned.slice(lastColon + 1);
        } else if (firstColon === -1) {
            host = cleaned;
        }
    }
    if (host === '0.0.0.0' || host === '::' || host === '') {
        host = fallbackHost;
    }
    return { host, port };
}

function hostForUrl(host) {
    return host.includes(':') ? `[${host}]` : host;
}

async function openDashboard() {
    try {
        if (!(await getServiceStatus())) {
            ui.addNotification(null, E('p', _('Service is not running.')), 'error');
            return;
        }

        const newWindow = window.open(
            L.url('admin/services/ssclash/dashboard'),
            '_blank'
        );
        if (!newWindow) {
            ui.addNotification(null, E('p', _('Popup was blocked. Please allow popups for this site.')), 'warning');
        }
    } catch (error) {
        console.error(_('Error opening dashboard:'), error);
        ui.addNotification(null, E('p', _('Failed to open dashboard: %s').format(error.message)), 'error');
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

async function initializeAceEditor(content, readOnly) {
    await loadScript('/luci-static/resources/view/ssclash/ace/ace.js');
    ace.config.set('basePath', '/luci-static/resources/view/ssclash/ace/');
    editor = ace.edit("editor");
    editor.setTheme("ace/theme/tomorrow_night_bright");
    editor.session.setMode("ace/mode/yaml");
    editor.setValue(content);
    editor.clearSelection();
    editor.setOptions({
        fontSize: "12px",
        showPrintMargin: false,
        wrap: true,
        readOnly: !!readOnly
    });
}

// =============================================================================
// SECTION: SSClash version / update footer helpers
// =============================================================================

// Keep in sync with the PARTY release tag.
const SSCLASH_VERSION = '4.7.0-party.4';

const SSCLASH_REPO = 'ponkcore/SSClash-PARTY';
const SSCLASH_RELEASES_URL = 'https://github.com/' + SSCLASH_REPO + '/releases';
const SSCLASH_RELEASES_API = 'https://api.github.com/repos/' + SSCLASH_REPO + '/releases?per_page=20';
const SSCLASH_MAINTAINER_URL = 'https://github.com/ponkcore';
const SSCLASH_UPSTREAM_URL = 'https://github.com/zerolabnet/SSClash';
const SSCLASH_AUTHOR_URL  = 'https://zerolab.net';
const SSCLASH_DONATE_URL  = 'https://zerolab.net/donate/';

function parseSemver(s) {
    const m = (s || '').match(/^v?(\d+)\.(\d+)\.(\d+)(?:-party\.(\d+))?$/i);
    return m ? [+m[1], +m[2], +m[3], +(m[4] || 0)] : null;
}

function cmpSemver(a, b) {
    const pa = parseSemver(a), pb = parseSemver(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
}

async function getLatestSSClashRelease() {
    try {
        const resp = await fetch(SSCLASH_RELEASES_API);
        if (!resp.ok) return null;
        const releases = await resp.json();
        if (!Array.isArray(releases)) return null;
        const candidates = releases.filter(function(release) {
            return release && !release.draft && parseSemver(release.tag_name);
        });
        candidates.sort(function(a, b) {
            return cmpSemver(b.tag_name, a.tag_name);
        });
        const d = candidates[0];
        if (!d) return null;
        return { version: d.tag_name, url: d.html_url || SSCLASH_RELEASES_URL };
    } catch (_e) {
        return null;
    }
}

return view.extend({
    load: function() {
        return Promise.all([
            L.resolveDefault(fs.read('/opt/clash/config.yaml'), ''),
            L.resolveDefault(uci.load('ssclash_profile'), null),
            L.resolveDefault(fs.read(PROFILE_STATUS_FILE), ''),
            L.resolveDefault(fs.read(LINKS_FILE), ''),
            L.resolveDefault(fs.read(TEMPLATE_CATALOG_FILE), '')
        ]);
    },
    render: async function(data) {
        const config = data[0];
        let profileStatus = parseProfileStatus(data[2]);
        const storedLinks = String(data[3] || '');
        const running = await getServiceStatus();
        let subscriptionProfiles = uci.sections('ssclash_profile', 'subscription');
        if (!subscriptionProfiles.length) {
            const sectionID = uci.add('ssclash_profile', 'subscription', 'default');
            uci.set('ssclash_profile', sectionID, 'name', 'Default');
            uci.set('ssclash_profile', sectionID, 'enabled', '0');
            uci.set('ssclash_profile', sectionID, 'url', '');
            uci.set('ssclash_profile', sectionID, 'rules_mode', 'auto');
            uci.set('ssclash_profile', sectionID, 'template_id', 'russia');
            uci.set('ssclash_profile', sectionID, 'interval', '3600');
            uci.set('ssclash_profile', sectionID, 'user_agent', 'auto');
            uci.set('ssclash_profile', sectionID, 'device_os', 'OpenWrt');
            subscriptionProfiles = uci.sections('ssclash_profile', 'subscription');
        }
        let activeProfileID = uci.get('ssclash_profile', 'main', 'active_profile') || 'default';
        if (!subscriptionProfiles.some(function(profile) {
            return profile['.name'] === activeProfileID;
        })) {
            activeProfileID = subscriptionProfiles[0]['.name'];
        }
        let selectedProfileID = activeProfileID;
        const selectedProfile = function() {
            return subscriptionProfiles.find(function(profile) {
                return profile['.name'] === selectedProfileID;
            }) || subscriptionProfiles[0];
        };
        const profileOption = function(option, fallback) {
            const profile = selectedProfile();
            const value = profile ? profile[option] : null;
            return value == null || value === '' ? fallback : value;
        };
        const configuredSourceMode = uci.get('ssclash_profile', 'main', 'source_mode') ||
            (profileOption('url', '') ? 'subscription' : 'manual');
        const configuredRulesMode = profileOption('rules_mode', 'auto');
        let mainTemplateID = uci.get('ssclash_profile', 'main', 'template_id') || 'russia';
        const configuredTemplateID = configuredSourceMode === 'subscription'
            ? profileOption('template_id', 'russia') : mainTemplateID;
        let manualActions = null;
        let configDescription = null;

        let templates = [];
        try {
            const catalog = JSON.parse(String(data[4] || ''));
            if (catalog && Array.isArray(catalog.templates)) {
                templates = catalog.templates.filter(function(item) {
                    return item && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(item.id || '');
                });
            }
        } catch (_e) {}
        if (!templates.length) {
            templates = [{ id: 'russia', name: 'Russia', description: '' }];
        }

        const sourceModeSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'width: 100%; max-width: 360px;'
        }, [
            E('option', { 'value': 'subscription' }, _('Subscription')),
            E('option', { 'value': 'links' }, _('Proxy links')),
            E('option', { 'value': 'manual' }, _('Manual YAML'))
        ]);
        sourceModeSelect.value = ['subscription', 'links', 'manual'].includes(configuredSourceMode)
            ? configuredSourceMode : 'manual';
        managedProfileConfigured = sourceModeSelect.value !== 'manual';

        const subscriptionInput = E('input', {
            'class': 'cbi-input-text',
            'id': 'ssclash-managed-subscription',
            'type': 'password',
            'name': 'ssclash-managed-subscription',
            'autocomplete': 'new-password',
            'spellcheck': 'false',
            'placeholder': 'https://subscription.example/profile',
            'style': 'width: 100%; min-width: 260px;'
        });
        subscriptionInput.value = profileOption('url', '');

        const rulesModeSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'width: 100%; max-width: 360px;'
        }, [
            E('option', { 'value': 'auto' }, _('Automatic: use a complete remote policy')),
            E('option', { 'value': 'template' }, _('Always use the selected PARTY template'))
        ]);
        rulesModeSelect.value = configuredRulesMode === 'template' ? 'template' : 'auto';

        const templateSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'width: 100%; max-width: 360px;'
        }, templates.map(function(item) {
            return E('option', { 'value': item.id }, item.name || item.id);
        }));
        templateSelect.value = templates.some(function(item) {
            return item.id === configuredTemplateID;
        }) ? configuredTemplateID : templates[0].id;

        const userAgentInput = E('input', {
            'class': 'cbi-input-text',
            'type': 'text',
            'autocomplete': 'off',
            'spellcheck': 'false',
            'placeholder': 'auto',
            'style': 'width: 100%;'
        });
        userAgentInput.value = profileOption('user_agent', 'auto');

        const hwidInput = E('input', {
            'class': 'cbi-input-text',
            'type': 'password',
            'autocomplete': 'new-password',
            'spellcheck': 'false',
            'placeholder': _('Generated automatically only when required'),
            'style': 'width: 100%;'
        });
        hwidInput.value = profileOption('hwid', '');
        hwidInput.dataset.originalValue = profileOption('hwid', '');

        const showHWIDButton = E('button', {
            'class': 'btn',
            'type': 'button',
            'style': 'margin: 0; white-space: nowrap;',
            'click': function() {
                const showing = hwidInput.type === 'text';
                hwidInput.type = showing ? 'password' : 'text';
                showHWIDButton.textContent = showing ? _('Show') : _('Hide');
            }
        }, _('Show'));

        const showSubscriptionButton = E('button', {
            'class': 'btn',
            'type': 'button',
            'style': 'margin: 0; white-space: nowrap;',
            'click': function() {
                const showing = subscriptionInput.type === 'text';
                subscriptionInput.type = showing ? 'password' : 'text';
                showSubscriptionButton.textContent = showing ? _('Show') : _('Hide');
            }
        }, _('Show'));

        const intervalInput = E('input', {
            'class': 'cbi-input-text',
            'type': 'number',
            'min': '300',
            'max': '604800',
            'step': '60',
            'style': 'width: 130px;'
        });
        intervalInput.value = profileOption('interval', '3600');

        const autoUpdateInput = E('input', {
            'type': 'checkbox'
        });
        autoUpdateInput.checked = profileOption('enabled', '0') === '1';

        const profileSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'width: 100%; max-width: 360px;'
        });
        const profileNameInput = E('input', {
            'class': 'cbi-input-text',
            'type': 'text',
            'maxlength': '64',
            'autocomplete': 'off',
            'spellcheck': 'false',
            'style': 'width: 100%; max-width: 360px;'
        });

        const renderProfileOptions = function() {
            profileSelect.replaceChildren();
            subscriptionProfiles.forEach(function(profile) {
                const id = profile['.name'];
                const name = String(profile.name || id);
                const suffix = id === activeProfileID ? _(' (active)') : '';
                profileSelect.appendChild(E('option', { 'value': id }, name + suffix));
            });
            profileSelect.value = selectedProfileID;
        };
        renderProfileOptions();

        const linksList = E('div', {
            'style': 'display: flex; flex-direction: column; gap: 8px;'
        });
        const bulkLinksInput = E('textarea', {
            'class': 'cbi-input-textarea',
            'rows': '4',
            'spellcheck': 'false',
            'placeholder': 'vless://…\nss://…\nhy2://…',
            'style': 'width: 100%; font-family: monospace;'
        });

        const addLinkRow = function(value) {
            const input = E('input', {
                'class': 'cbi-input-text',
                'type': 'password',
                'data-proxy-link': '1',
                'autocomplete': 'new-password',
                'spellcheck': 'false',
                'placeholder': 'vless://, ss://, hy2://, trojan://, …',
                'style': 'flex: 1; min-width: 220px; font-family: monospace;'
            });
            input.value = value || '';
            const showButton = E('button', {
                'class': 'btn',
                'type': 'button',
                'style': 'margin: 0;',
                'click': function() {
                    const showing = input.type === 'text';
                    input.type = showing ? 'password' : 'text';
                    showButton.textContent = showing ? _('Show') : _('Hide');
                }
            }, _('Show'));
            const row = E('div', {
                'style': 'display: flex; flex-wrap: wrap; gap: 8px; align-items: center;'
            }, [
                input,
                showButton,
                E('button', {
                    'class': 'btn cbi-button-negative',
                    'type': 'button',
                    'style': 'margin: 0;',
                    'click': function() { row.remove(); }
                }, _('Delete'))
            ]);
            linksList.appendChild(row);
        };

        const initialLinks = storedLinks.split(/\r?\n/).map(function(line) {
            return line.trim();
        }).filter(Boolean);
        initialLinks.forEach(addLinkRow);
        if (!initialLinks.length) addLinkRow('');

        const addBulkLinksButton = E('button', {
            'class': 'btn',
            'type': 'button',
            'style': 'margin: 0;',
            'click': function() {
                const existing = new Set(Array.from(
                    linksList.querySelectorAll('input[data-proxy-link]')
                ).map(function(input) { return input.value.trim(); }).filter(Boolean));
                bulkLinksInput.value.split(/\r?\n/).map(function(line) {
                    return line.trim();
                }).filter(Boolean).forEach(function(link) {
                    if (!existing.has(link)) {
                        existing.add(link);
                        addLinkRow(link);
                    }
                });
                bulkLinksInput.value = '';
            }
        }, _('Add pasted links'));

        const profileStatusBox = E('div', {
            'style': 'margin-top: 14px; padding: 10px 12px; border: 1px solid rgba(127,127,127,0.22); border-radius: 4px;'
        });

        const renderProfileStatus = function(status) {
            status = status || {};
            while (profileStatusBox.firstChild) {
                profileStatusBox.removeChild(profileStatusBox.firstChild);
            }

            const state = status.state || 'idle';
            const summary = status.summary || null;
            const metrics = [];
            if (status.profile_id) metrics.push(_('Profile: %s').format(status.profile_id));
            if (summary) {
                if (summary.source_format) metrics.push(_('Source: %s').format(summary.source_format));
                if (summary.rules_source) metrics.push(_('Policy: %s').format(summary.rules_source));
                if (summary.template_id) metrics.push(_('Template: %s').format(summary.template_id));
                if (summary.input_links) metrics.push(_('Input links: %s').format(summary.input_links));
                if (summary.skipped_lines) metrics.push(_('Rejected lines: %s').format(summary.skipped_lines));
                metrics.push(
                    _('Inline nodes: %s').format(summary.inline_proxies || 0),
                    _('Proxy providers: %s').format(summary.proxy_providers || 0),
                    _('Groups: %s').format(summary.proxy_groups || 0),
                    _('Rule providers: %s').format(summary.rule_providers || 0),
                    _('Rules: %s').format(summary.rules || 0),
                    _('DNS mode: %s').format(summary.dns_mode || 'redir-host')
                );
            }

            profileStatusBox.appendChild(E('div', {
                'style': 'display: flex; flex-wrap: wrap; align-items: center; gap: 8px;'
            }, [
                E('span', {
                    'class': 'label',
                    'style': 'padding: 3px 8px; color: white; background: ' +
                        profileStatusColor(state) + '; border-radius: 3px;'
                }, state),
                E('span', {}, status.message || _('Managed profile sync has not run yet.')),
                E('span', {
                    'style': 'margin-left: auto; opacity: 0.7; font-size: 11px;'
                }, formatProfileTime(status.time))
            ]));

            if (metrics.length) {
                profileStatusBox.appendChild(E('div', {
                    'style': 'margin-top: 7px; opacity: 0.75; font-size: 11px;'
                }, metrics.join(' \u00b7 ')));
            }
        };
        renderProfileStatus(profileStatus);

        const profileButtons = [];
        const managedInputs = [
            sourceModeSelect, profileSelect, profileNameInput,
            subscriptionInput, rulesModeSelect, templateSelect,
            intervalInput, autoUpdateInput, userAgentInput, hwidInput,
            showSubscriptionButton, showHWIDButton, bulkLinksInput, addBulkLinksButton
        ];
        const setProfileBusy = function(busy) {
            profileButtons.forEach(function(button) {
                button.disabled = busy;
            });
            managedInputs.forEach(function(input) { input.disabled = busy; });
            linksList.querySelectorAll('input,button').forEach(function(input) {
                input.disabled = busy;
            });
            if (startStopButton) startStopButton.disabled = busy;
        };

        const collectProxyLinks = function() {
            const values = [];
            const seen = new Set();
            linksList.querySelectorAll('input[data-proxy-link]').forEach(function(input) {
                const link = input.value.trim();
                if (!link) return;
                if (link.length > 16384 || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(link)) {
                    throw new Error(_('Every proxy entry must be a single URI such as vless://, ss:// or hy2:// without spaces.'));
                }
                const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
                if (['data', 'file', 'javascript'].includes(scheme)) {
                    throw new Error(_('The proxy-link scheme %s is not allowed.').format(scheme));
                }
                if (!seen.has(link)) {
                    seen.add(link);
                    values.push(link);
                }
            });
            return values;
        };

        const collectProfileSettings = function() {
            const sourceMode = sourceModeSelect.value;
            const url = subscriptionInput.value.trim();
            const interval = Number.parseInt(intervalInput.value, 10);
            const enabled = autoUpdateInput.checked;
            const rulesMode = rulesModeSelect.value;
            const templateID = templateSelect.value;
            const userAgent = userAgentInput.value.trim() || 'auto';
            const hwid = hwidInput.value.trim();
            const profileName = profileNameInput.value.trim();

            if (!['subscription', 'links', 'manual'].includes(sourceMode)) {
                throw new Error(_('Select a valid configuration source.'));
            }
            if (sourceMode === 'subscription' && url &&
                (!/^https:\/\/[^\s'"\\]+$/i.test(url) || url.length > 2048)) {
                throw new Error(_('The subscription must be a valid HTTPS URL without spaces.'));
            }
            if (sourceMode === 'subscription' && enabled && !url) {
                throw new Error(_('Enter a subscription URL before enabling automatic updates.'));
            }
            if (sourceMode === 'subscription' &&
                (!profileName || profileName.length > 64 || /[\u0000-\u001f\u007f]/.test(profileName))) {
                throw new Error(_('Profile name must contain 1 through 64 printable characters.'));
            }
            if (sourceMode === 'subscription' &&
                (!Number.isInteger(interval) || interval < 300 || interval > 604800)) {
                throw new Error(_('Update interval must be between 300 and 604800 seconds.'));
            }
            if (sourceMode !== 'manual' && (!['auto', 'template'].includes(rulesMode) ||
                !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(templateID))) {
                throw new Error(_('The routing-policy selection is invalid.'));
            }
            if (sourceMode === 'subscription' && (userAgent.length > 256 || /[\r\n]/.test(userAgent) ||
                hwid.length > 512 || /[\r\n]/.test(hwid))) {
                throw new Error(_('A subscription request header contains an invalid value.'));
            }
            return {
                sourceMode: sourceMode,
                profileID: selectedProfileID,
                profileName: profileName,
                url: url,
                interval: String(interval),
                enabled: enabled,
                rulesMode: sourceMode === 'links' ? 'template' : rulesMode,
                templateID: templateID,
                userAgent: userAgent,
                hwid: hwid,
                links: sourceMode === 'links' ? collectProxyLinks() : null
            };
        };

        const writeLinksFile = async function(links) {
            const temporary = '/etc/ssclash-party/.links.txt.luci.' +
                Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            const body = links.length ? links.join('\n') + '\n' : '';
            const encoded = encodeBase64Utf8(body);
            const partFiles = [];
            const base64File = temporary + '.b64';
            if (encoded.byteLength > LINKS_MAX_BYTES) {
                throw new Error(_('The proxy-link source exceeds the 5 MiB safety limit.'));
            }
            try {
                const mkdirResult = await fs.exec('/bin/mkdir', ['-p', '/etc/ssclash-party']);
                if (mkdirResult.code !== 0) throw new Error(_('Unable to create the proxy-link directory.'));
                const directoryMode = await fs.exec('/bin/chmod', ['700', '/etc/ssclash-party']);
                if (directoryMode.code !== 0) throw new Error(_('Unable to protect the proxy-link directory.'));

                if (encoded.byteLength <= LINKS_INLINE_WRITE_MAX) {
                    await fs.write(temporary, body);
                } else {
                    for (let offset = 0, index = 0;
                        offset < encoded.value.length;
                        offset += LINKS_BASE64_CHUNK_SIZE, index++) {
                        const part = temporary + '.part.' + String(index).padStart(6, '0');
                        partFiles.push(part);
                        await fs.write(part, encoded.value.slice(offset, offset + LINKS_BASE64_CHUNK_SIZE));
                    }
                    const decodeCommand = 'set -e; umask 077; : > ' + base64File +
                        '; for part in ' + temporary + '.part.*; do cat "$part" >> ' + base64File +
                        '; done; base64 -d ' + base64File + ' > ' + temporary;
                    const decodeResult = await fs.exec('/bin/sh', ['-c', decodeCommand]);
                    if (decodeResult.code !== 0) throw new Error(_('Unable to assemble the proxy-link source.'));
                }
                const chmodResult = await fs.exec('/bin/chmod', ['600', temporary]);
                if (chmodResult.code !== 0) throw new Error(_('Unable to protect the proxy-link source.'));
                const moveResult = await fs.exec('/bin/mv', ['-f', temporary, LINKS_FILE]);
                if (moveResult.code !== 0) throw new Error(_('Unable to save the proxy-link source.'));
            } finally {
                try { await fs.remove(temporary); } catch (_e) {}
                try { await fs.remove(base64File); } catch (_e) {}
                for (const part of partFiles) {
                    try { await fs.remove(part); } catch (_e) {}
                }
            }
        };

        const reconfigureProfileUpdater = async function(sourceMode, profileID) {
            const enabled = uci.get('ssclash_profile', profileID, 'enabled') === '1';
            const url = uci.get('ssclash_profile', profileID, 'url') || '';
            let result;
            if (sourceMode === 'subscription' && enabled && url) {
                result = await fs.exec(PROFILE_INIT, ['enable']);
                if (result.code === 0) result = await fs.exec(PROFILE_INIT, ['restart']);
            } else {
                result = await fs.exec(PROFILE_INIT, ['stop']);
                if (result.code === 0) result = await fs.exec(PROFILE_INIT, ['disable']);
            }
            if (result.code !== 0) {
                throw new Error(_('The managed update service could not be reconfigured.'));
            }
        };

        const saveProfileSettings = async function(showNotification) {
            const settings = collectProfileSettings();

            if (settings.links !== null) {
                await writeLinksFile(settings.links);
            }
            uci.set('ssclash_profile', 'main', 'source_mode', settings.sourceMode);
            if (settings.sourceMode === 'subscription') {
                uci.set('ssclash_profile', settings.profileID, 'name', settings.profileName);
                uci.set('ssclash_profile', settings.profileID, 'rules_mode', settings.rulesMode);
                uci.set('ssclash_profile', settings.profileID, 'template_id', settings.templateID);
                uci.set('ssclash_profile', settings.profileID, 'url', settings.url);
                uci.set('ssclash_profile', settings.profileID, 'interval', settings.interval);
                uci.set('ssclash_profile', settings.profileID, 'enabled', settings.enabled ? '1' : '0');
                uci.set('ssclash_profile', settings.profileID, 'user_agent', settings.userAgent);
                if (settings.hwid !== hwidInput.dataset.originalValue) {
                    uci.set('ssclash_profile', settings.profileID, 'hwid', settings.hwid);
                }
            } else if (settings.sourceMode === 'links') {
                uci.set('ssclash_profile', 'main', 'rules_mode', 'template');
                uci.set('ssclash_profile', 'main', 'template_id', settings.templateID);
                mainTemplateID = settings.templateID;
            }
            await uci.save();
            await callUciCommit('ssclash_profile');
            hwidInput.dataset.originalValue = settings.hwid;

            if (settings.sourceMode === 'subscription') {
                const profile = selectedProfile();
                Object.assign(profile, {
                    name: settings.profileName,
                    rules_mode: settings.rulesMode,
                    template_id: settings.templateID,
                    url: settings.url,
                    interval: settings.interval,
                    enabled: settings.enabled ? '1' : '0',
                    user_agent: settings.userAgent,
                    hwid: settings.hwid
                });
                renderProfileOptions();
            }

            await reconfigureProfileUpdater(settings.sourceMode, activeProfileID);

            managedProfileConfigured = settings.sourceMode !== 'manual';
            updateSourceVisibility();
            if (showNotification) {
                ui.addNotification(null, E('p',
                    _('Configuration-source settings saved. The active YAML and selected runtime profile were not changed.')
                ), 'info');
            }
            return settings;
        };

        const refreshProfileStatus = async function(fallbackText) {
            try {
                profileStatus = parseProfileStatus(await fs.read(PROFILE_STATUS_FILE));
            } catch (_e) {
                profileStatus = parseProfileStatus(fallbackText);
            }
            renderProfileStatus(profileStatus);
            return profileStatus;
        };

        const runProfileAction = async function(action) {
            setProfileBusy(true);
            try {
                await saveProfileSettings(false);
                if (sourceModeSelect.value === 'manual') {
                    throw new Error(_('Manual YAML mode does not use managed synchronization.'));
                }
                renderProfileStatus({
                    state: 'working',
                    profile_id: selectedProfileID,
                    message: action === 'sync-start'
                        ? _('Generating, validating and starting with rollback protection…')
                        : action === 'activate'
                            ? _('Validating and switching the active subscription profile…')
                            : action === 'validate'
                                ? _('Downloading and validating the saved profile without activation…')
                                : _('Generating and validating the managed configuration…'),
                    time: Math.floor(Date.now() / 1000)
                });

                const actionArguments = [ action ];
                if (action === 'validate' || action === 'activate') {
                    actionArguments.push(selectedProfileID);
                }
                const result = await fs.exec(PROFILE_HELPER, actionArguments);
                const status = await refreshProfileStatus(result.stdout);
                if (result.code !== 0) {
                    throw new Error(status.message || _('Managed profile operation failed.'));
                }

                if (status.summary && status.summary.skipped_lines) {
                    ui.addNotification(null, E('p', _(
                        'The source was applied, but %s syntactically invalid line(s) were rejected.'
                    ).format(status.summary.skipped_lines)), 'warning');
                }

                ui.addNotification(null, E('p',
                    action === 'activate'
                        ? _('The selected subscription profile is now active. A running service was switched transactionally; a stopped service remains stopped.')
                        : action === 'validate'
                            ? _('The subscription profile is valid and was saved as a last-good candidate without activation.')
                            : action === 'sync-start'
                        ? _('Managed configuration is active and passed all health checks.')
                        : _('Managed configuration was applied successfully.')
                ), 'info');

                if (action === 'activate') {
                    activeProfileID = selectedProfileID;
                    try {
                        await reconfigureProfileUpdater('subscription', activeProfileID);
                    } catch (error) {
                        ui.addNotification(null, E('p', _(
                            'The profile switched successfully, but its automatic-update daemon could not be reconfigured: %s'
                        ).format(error.message)), 'warning');
                    }
                    renderProfileOptions();
                }

                try {
                    const updatedConfig = await fs.read('/opt/clash/config.yaml');
                    if (editor && updatedConfig) {
                        editor.setValue(updatedConfig);
                        editor.clearSelection();
                    }
                } catch (_e) {}

                if (action === 'activate' && !running) {
                    window.setTimeout(function() { window.location.reload(); }, 300);
                } else if ((action === 'sync-start' || action === 'activate') &&
                    await view_ssclash_utils.waitForServiceStatus(getServiceStatus, true, 15000)) {
                    window.location.reload();
                }
            } catch (e) {
                await refreshProfileStatus('');
                ui.addNotification(null, E('p',
                    _('Managed profile operation failed: %s').format(e.message)
                ), 'error');
            } finally {
                setProfileBusy(false);
                updateSourceVisibility();
            }
        };

        const saveProfileButton = E('button', {
            'class': 'btn',
            'click': async function() {
                setProfileBusy(true);
                try {
                    await saveProfileSettings(true);
                } catch (e) {
                    ui.addNotification(null, E('p',
                        _('Unable to save managed profile settings: %s').format(e.message)
                    ), 'error');
                } finally {
                    setProfileBusy(false);
                    updateSourceVisibility();
                }
            }
        }, _('Save settings'));
        const syncProfileButton = E('button', {
            'class': 'btn',
            'click': function() {
                runProfileAction('sync');
            }
        }, _('Apply now'));
        const startManagedButton = E('button', {
            'class': 'btn cbi-button-positive',
            'click': function() {
                runProfileAction('sync-start');
            }
        }, _('Apply & guarded start'));
        const validateProfileButton = E('button', {
            'class': 'btn',
            'click': function() {
                runProfileAction('validate');
            }
        }, _('Validate without switching'));
        const activateProfileButton = E('button', {
            'class': 'btn cbi-button-positive',
            'click': function() {
                runProfileAction('activate');
            }
        }, _('Switch to this profile'));
        const addProfileButton = E('button', {
            'class': 'btn',
            'type': 'button',
            'click': async function() {
                const requestedName = window.prompt(_('Name for the new subscription profile:'), _('New profile'));
                if (requestedName == null) return;
                const name = requestedName.trim();
                if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
                    ui.addNotification(null, E('p', _('Profile name must contain 1 through 64 printable characters.')), 'error');
                    return;
                }
                setProfileBusy(true);
                try {
                    let id;
                    do {
                        id = 'profile_' + Date.now().toString(36) +
                            Math.random().toString(36).slice(2, 7);
                    } while (subscriptionProfiles.some(function(profile) {
                        return profile['.name'] === id;
                    }));
                    uci.add('ssclash_profile', 'subscription', id);
                    uci.set('ssclash_profile', id, 'name', name);
                    uci.set('ssclash_profile', id, 'enabled', '0');
                    uci.set('ssclash_profile', id, 'url', '');
                    uci.set('ssclash_profile', id, 'rules_mode', 'auto');
                    uci.set('ssclash_profile', id, 'template_id', templateSelect.value || 'russia');
                    uci.set('ssclash_profile', id, 'interval', '3600');
                    uci.set('ssclash_profile', id, 'user_agent', 'auto');
                    uci.set('ssclash_profile', id, 'device_os', 'OpenWrt');
                    await uci.save();
                    await callUciCommit('ssclash_profile');
                    subscriptionProfiles = uci.sections('ssclash_profile', 'subscription');
                    selectedProfileID = id;
                    renderProfileOptions();
                    populateSelectedProfile();
                    updateSourceVisibility();
                    ui.addNotification(null, E('p', _('The new profile was saved. Add its subscription URL, then validate or switch to it.')), 'info');
                } catch (error) {
                    ui.addNotification(null, E('p', _('Unable to add subscription profile: %s').format(error.message)), 'error');
                } finally {
                    setProfileBusy(false);
                    updateSourceVisibility();
                }
            }
        }, _('Add profile'));
        const deleteProfileButton = E('button', {
            'class': 'btn cbi-button-negative',
            'type': 'button',
            'click': async function() {
                if (selectedProfileID === activeProfileID) {
                    ui.addNotification(null, E('p', _('Switch to another profile before deleting the active profile.')), 'warning');
                    return;
                }
                if (!window.confirm(_('Delete the selected subscription profile and its protected cached candidate?'))) return;
                setProfileBusy(true);
                try {
                    const result = await fs.exec(PROFILE_HELPER, [ 'delete', selectedProfileID ]);
                    if (result.code !== 0) {
                        const status = parseProfileStatus(result.stdout);
                        throw new Error(status.message || _('Profile deletion failed.'));
                    }
                    window.location.reload();
                } catch (error) {
                    ui.addNotification(null, E('p', _('Unable to delete subscription profile: %s').format(error.message)), 'error');
                    setProfileBusy(false);
                }
            }
        }, _('Delete profile'));
        profileButtons.push(
            saveProfileButton, syncProfileButton, startManagedButton,
            validateProfileButton, activateProfileButton,
            addProfileButton, deleteProfileButton
        );

        const profileManagementSection = E('div', {
            'style': 'display: grid; grid-template-columns: minmax(150px, 210px) minmax(260px, 1fr); gap: 10px 14px; align-items: center; margin-bottom: 14px;'
        }, [
            E('label', {}, _('Saved subscription')),
            profileSelect,
            E('label', {}, _('Profile name')),
            profileNameInput,
            E('span', {}),
            E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 8px;' }, [
                addProfileButton,
                deleteProfileButton
            ])
        ]);

        const subscriptionSection = E('div', {
            'style': 'display: grid; grid-template-columns: minmax(150px, 210px) minmax(260px, 1fr); gap: 10px 14px; align-items: center;'
        }, [
            E('label', { 'for': 'ssclash-managed-subscription' }, _('Subscription URL')),
            E('div', { 'style': 'display: flex; align-items: center; gap: 8px;' },
                [ subscriptionInput, showSubscriptionButton ]),
            E('label', {}, _('Routing policy')),
            rulesModeSelect,
            E('label', {}, _('Fallback template')),
            templateSelect,
            E('label', {}, _('Update interval')),
            E('div', { 'style': 'display: flex; align-items: center; gap: 8px;' }, [
                intervalInput,
                E('span', { 'style': 'opacity: 0.75;' }, _('seconds (3600 = one hour)'))
            ]),
            E('label', {}, _('Automatic updates')),
            E('label', { 'style': 'display: inline-flex; align-items: center; gap: 8px;' }, [
                autoUpdateInput,
                E('span', {}, _('Download, validate and hot-reload on schedule'))
            ])
        ]);

        const linksSection = E('div', { 'style': 'display: none;' }, [
            E('div', {
                'style': 'display: grid; grid-template-columns: minmax(150px, 210px) minmax(260px, 1fr); gap: 10px 14px; align-items: center; margin-bottom: 12px;'
            }, [
                E('label', {}, _('Routing template')),
                templateSelect.cloneNode(true)
            ]),
            E('p', { 'class': 'cbi-section-descr' }, _(
                'Add any number of Mihomo-compatible share links. PARTY stores them locally and Mihomo performs the authoritative protocol parsing.'
            )),
            linksList,
            E('button', {
                'class': 'btn',
                'type': 'button',
                'style': 'margin: 10px 0;',
                'click': function() { addLinkRow(''); }
            }, _('Add one link')),
            E('details', { 'style': 'margin-top: 8px;' }, [
                E('summary', {}, _('Bulk paste')),
                E('div', { 'style': 'margin-top: 8px;' }, [ bulkLinksInput, addBulkLinksButton ])
            ])
        ]);

        const linksTemplateSelect = linksSection.querySelector('select');
        linksTemplateSelect.value = templateSelect.value;
        linksTemplateSelect.addEventListener('change', function() {
            templateSelect.value = linksTemplateSelect.value;
        });
        templateSelect.addEventListener('change', function() {
            linksTemplateSelect.value = templateSelect.value;
        });

        const populateSelectedProfile = function() {
            const profile = selectedProfile();
            if (!profile) return;
            profileNameInput.value = profile.name || profile['.name'];
            subscriptionInput.value = profile.url || '';
            intervalInput.value = profile.interval || '3600';
            autoUpdateInput.checked = profile.enabled === '1';
            rulesModeSelect.value = profile.rules_mode === 'template' ? 'template' : 'auto';
            const wantedTemplate = profile.template_id || 'russia';
            templateSelect.value = templates.some(function(item) {
                return item.id === wantedTemplate;
            }) ? wantedTemplate : templates[0].id;
            linksTemplateSelect.value = templateSelect.value;
            userAgentInput.value = profile.user_agent || 'auto';
            hwidInput.value = profile.hwid || '';
            hwidInput.dataset.originalValue = profile.hwid || '';
        };

        profileSelect.addEventListener('change', function() {
            selectedProfileID = profileSelect.value;
            populateSelectedProfile();
            renderProfileStatus(profileStatus);
            updateSourceVisibility();
        });
        populateSelectedProfile();
        if (configuredSourceMode === 'links') {
            templateSelect.value = templates.some(function(item) {
                return item.id === mainTemplateID;
            }) ? mainTemplateID : templates[0].id;
            linksTemplateSelect.value = templateSelect.value;
        }

        const manualSection = E('div', { 'style': 'display: none;' }, [
            E('p', { 'class': 'cbi-section-descr' }, _(
                'The YAML editor below is authoritative in this mode. Subscription scheduling is stopped, and PARTY will not regenerate the file.'
            ))
        ]);

        const advancedSection = E('details', { 'style': 'margin-top: 12px;' }, [
            E('summary', {}, _('Advanced subscription compatibility')),
            E('div', {
                'style': 'display: grid; grid-template-columns: minmax(150px, 210px) minmax(260px, 1fr); gap: 10px 14px; align-items: center; margin-top: 10px;'
            }, [
                E('label', {}, _('Primary User-Agent')),
                userAgentInput,
                E('label', {}, _('HWID override')),
                E('div', { 'style': 'display: flex; align-items: center; gap: 8px;' },
                    [ hwidInput, showHWIDButton ])
            ]),
            E('p', { 'style': 'font-size: 11px; opacity: 0.72;' }, _(
                'The first requests never include HWID headers. If the server requires them, PARTY creates one stable router ID and retries. Leave User-Agent on auto unless a provider documents a custom value.'
            ))
        ]);

        const managedButtonRow = E('div', {
            'style': 'display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px;'
        }, [
            saveProfileButton,
            syncProfileButton,
            startManagedButton,
            validateProfileButton,
            activateProfileButton
        ]);

        const managedProfileCard = E('div', {
            'id': 'ssclash-managed-profile',
            'data-version': SSCLASH_MANAGED_PROFILE_UI,
            'style': 'margin: 0 0 22px; padding: 16px; border: 1px solid rgba(127,127,127,0.28); border-radius: 5px;'
        }, [
            E('h2', { 'style': 'margin-top: 0;' }, _('Configuration Source')),
            E('p', { 'class': 'cbi-section-descr' }, _(
                'Choose how PARTY obtains proxies and routing policy. Router-critical TProxy, DNS and controller settings always remain protected locally.'
            )),
            E('div', {
                'style': 'display: grid; grid-template-columns: minmax(150px, 210px) minmax(260px, 1fr); gap: 10px 14px; align-items: center; margin-bottom: 14px;'
            }, [
                E('label', {}, _('Source type')),
                sourceModeSelect
            ]),
            profileManagementSection,
            subscriptionSection,
            linksSection,
            manualSection,
            advancedSection,
            profileStatusBox,
            managedButtonRow,
            E('p', {
                'style': 'margin: 12px 0 0; font-size: 11px; opacity: 0.72;'
            }, _(
                'Every managed candidate is checked with Mihomo before activation. A failed download, policy, reload or health check leaves the last-known-good configuration active.'
            ))
        ]);

        const updateSourceVisibility = function() {
            const mode = sourceModeSelect.value;
            const subscriptionMode = mode === 'subscription';
            const selectedIsActive = selectedProfileID === activeProfileID;
            profileManagementSection.style.display = subscriptionMode ? 'grid' : 'none';
            subscriptionSection.style.display = mode === 'subscription' ? 'grid' : 'none';
            linksSection.style.display = mode === 'links' ? 'block' : 'none';
            manualSection.style.display = mode === 'manual' ? 'block' : 'none';
            advancedSection.style.display = mode === 'subscription' ? 'block' : 'none';
            syncProfileButton.style.display = mode === 'links' || (subscriptionMode && selectedIsActive) ? '' : 'none';
            startManagedButton.style.display = mode === 'links' || (subscriptionMode && selectedIsActive) ? '' : 'none';
            validateProfileButton.style.display = subscriptionMode ? '' : 'none';
            activateProfileButton.style.display = subscriptionMode && !selectedIsActive ? '' : 'none';
            deleteProfileButton.disabled = selectedIsActive || subscriptionProfiles.length <= 1;
            syncProfileButton.textContent = mode === 'links' ? _('Generate & apply') : _('Sync now');
            startManagedButton.textContent = mode === 'links'
                ? _('Generate & guarded start') : _('Sync & guarded start');
            if (editor) editor.setReadOnly(mode !== 'manual');
            if (manualActions) manualActions.style.display = mode === 'manual' ? 'flex' : 'none';
            if (configDescription) {
                configDescription.textContent = mode === 'manual'
                    ? _('Edit, validate and activate your complete Mihomo YAML below.')
                    : _('Read-only preview of the currently active generated Mihomo configuration.');
            }
        };
        sourceModeSelect.addEventListener('change', function() {
            if (sourceModeSelect.value === 'subscription') {
                populateSelectedProfile();
            } else if (sourceModeSelect.value === 'links') {
                templateSelect.value = templates.some(function(item) {
                    return item.id === mainTemplateID;
                }) ? mainTemplateID : templates[0].id;
                linksTemplateSelect.value = templateSelect.value;
            }
            updateSourceVisibility();
        });
        updateSourceVisibility();

        const writeAndTestConfig = async function() {
            if (sourceModeSelect.value !== 'manual') {
                throw new Error(_('Switch to Manual YAML mode before editing the active configuration.'));
            }
            await saveProfileSettings(false);
            const value = editor.getValue().trim() + '\n';
            const temporaryResult = await fs.exec('/bin/mktemp', [
                '/opt/clash/.config.yaml.manual.XXXXXX'
            ]);
            if (temporaryResult.code !== 0) {
                throw new Error(_('Unable to create a protected temporary configuration file.'));
            }
            const temporary = (temporaryResult.stdout || '').trim();
            if (!/^\/opt\/clash\/\.config\.yaml\.manual\.[A-Za-z0-9]+$/.test(temporary)) {
                throw new Error(_('The temporary configuration path was invalid.'));
            }

            try {
                await view_ssclash_utils.writeFile(temporary, value);
                const testResult = await fs.exec('/opt/clash/bin/clash', [
                    '-d', '/opt/clash', '-t', '-f', temporary
                ]);
                if (testResult.code !== 0) {
                    const detail = view_ssclash_utils.formatClashTestError(
                        testResult.stdout, testResult.stderr
                    );

                    ui.addNotification(null, E('div', {}, [
                        E('p', _('Configuration test failed — the active file was not changed. Please fix the errors below:')),
                        E('pre', {
                            'style': 'margin: 6px 0 0; padding: 0 0 0 10px; font-size: 11px; line-height: 1.45; font-family: monospace; white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto; background: none; border: 0; border-left: 2px solid rgba(0,0,0,0.18);'
                        }, detail || _('unknown error'))
                    ]), 'error');
                    return null;
                }

                const chmodResult = await fs.exec('/bin/chmod', ['600', temporary]);
                if (chmodResult.code !== 0) {
                    throw new Error(_('Unable to protect the temporary configuration file.'));
                }
                const moveResult = await fs.exec('/bin/mv', [
                    '-f', temporary, '/opt/clash/config.yaml'
                ]);
                if (moveResult.code !== 0) {
                    throw new Error(_('Unable to install the validated configuration file.'));
                }
                ui.addNotification(null, E('p', _('Configuration validated and saved successfully.')), 'info');
                return value;
            } finally {
                try {
                    await fs.remove(temporary);
                } catch (_e) {}
            }
        };

        const saveAndValidateOnly = async function() {
            if (startStopButton) startStopButton.disabled = true;
            try {
                const value = await writeAndTestConfig();
                if (value === null) return;

                ui.addNotification(null, E('p',
                    _('Configuration validated and saved without restarting or reloading the Clash service.')
                ), 'info');
            } catch(e) {
                ui.addNotification(null, E('p',
                    _('Unable to save contents: %s').format(e.message)
                ), 'error');
            } finally {
                if (startStopButton) startStopButton.disabled = false;
            }
        };

        const saveAndRestartCore = async function() {
            if (startStopButton) startStopButton.disabled = true;
            try {
                const value = await writeAndTestConfig();
                if (value === null) return;

                try {
                    await view_ssclash_utils.execDetached('/etc/init.d/clash reload');
                } catch (e) {}

                ui.addNotification(null, E('p', _('Service is restarting…')), 'info');

                if (await view_ssclash_utils.waitForServiceStatus(getServiceStatus, true)) {
                    ui.addNotification(null, E('p', _('Service reloaded successfully.')), 'info');
                    window.location.reload();
                } else {
                    notifyRestartPending();
                }
            } catch(e) {
                ui.addNotification(null, E('p', _('Unable to save contents: %s').format(e.message)), 'error');
            } finally {
                if (startStopButton) startStopButton.disabled = false;
            }
        };

        const saveAndReloadConfig = async function() {
            if (startStopButton) startStopButton.disabled = true;
            try {
                if (!(await getServiceStatus())) {
                    ui.addNotification(null, E('p',
                        _('Service is not running — config reload requires a running Mihomo instance. Use "Save & Restart core" instead.')
                    ), 'warning');
                    return;
                }

                const value = await writeAndTestConfig();
                if (value === null) return;

                const ec = parseYamlValue(value, 'external-controller');
                const ecTls = parseYamlValue(value, 'external-controller-tls');
                const secret = parseYamlValue(value, 'secret') || '';
                const useTls = !!ecTls;

                const { host, port } = normalizeHostPortFromAddr(
                    useTls ? ecTls : ec,
                    '127.0.0.1',
                    useTls ? '9443' : '9090'
                );
                const scheme = useTls ? 'https' : 'http';
                const authorizationResult = await fs.exec('/bin/mktemp', [
                    '/tmp/ssclash-reload-auth.XXXXXX'
                ]);
                if (authorizationResult.code !== 0) {
                    throw new Error(_('Unable to create a protected authorization file.'));
                }
                const authorizationFile = (authorizationResult.stdout || '').trim();
                if (!/^\/tmp\/ssclash-reload-auth\.[A-Za-z0-9]+$/.test(authorizationFile)) {
                    throw new Error(_('The authorization file path was invalid.'));
                }

                const curlArgs = [
                    '-sS', '-o', '/dev/null', '-w', '%{http_code}',
                    '-X', 'PUT',
                    '-H', 'Content-Type: application/json',
                    '-H', '@' + authorizationFile,
                    '--data', '{"path":"","payload":""}',
                    '--connect-timeout', '5',
                    '--max-time', '15'
                ];
                if (useTls) {
                    curlArgs.push('-k');
                }
                curlArgs.push(scheme + '://' + hostForUrl(host) + ':' + port + '/configs?force=true');

                let res;
                try {
                    await view_ssclash_utils.writeFile(
                        authorizationFile,
                        'Authorization: Bearer ' + secret + '\n'
                    );
                    const chmodResult = await fs.exec('/bin/chmod', ['600', authorizationFile]);
                    if (chmodResult.code !== 0) {
                        throw new Error(_('Unable to protect the authorization file.'));
                    }
                    res = await fs.exec('curl', curlArgs);
                } finally {
                    try {
                        await fs.remove(authorizationFile);
                    } catch (_e) {}
                }
                const httpCode = (res.stdout || '').trim();

                if (res.code !== 0 || (httpCode !== '204' && httpCode !== '200')) {
                    let detail = (res.stderr || '').trim();
                    if (useTls && /Protocol\s+"?https"?\s+not\s+supported/i.test(detail)) {
                        detail += ' ' + _('(Hint: the system curl has no HTTPS support. Install curl-ssl, or use plain external-controller for hot reload.)');
                    }
                    ui.addNotification(null, E('p',
                        _('Config reload failed (%s, HTTP %s). %s Try "Save & Restart core" for a full restart.')
                        .format(scheme, httpCode || 'n/a', detail ? detail : '')
                    ), 'error');
                    return;
                }

                fs.exec('/opt/clash/bin/clash-rules', ['update']).catch(function(err) {
                    ui.addNotification(null, E('p',
                        _('Config reloaded, but updating subscription IP cache failed: %s').format((err && err.message) || String(err))
                    ), 'warning');
                });

                ui.addNotification(null, E('p',
                    _('Config reloaded via Mihomo API — active connections preserved.')
                ), 'info');

                await view_ssclash_utils.waitForServiceStatus(
                    getServiceStatus, true, 5000
                );
            } catch(e) {
                ui.addNotification(null, E('p',
                    _('Config reload error: %s. Try "Save & Restart core" for a full restart.').format(e.message)
                ), 'error');
            } finally {
                if (startStopButton) startStopButton.disabled = false;
            }
        };

        const _light = view_ssclash_utils.isLightTheme();
        const splitMenu = E('div', {
            'class': 'ssclash-split-menu',
            'style': _light
                ? 'position: absolute; top: 100%; right: 0; display: none; min-width: 220px; margin-top: 3px; background: #fff; color: #333; border: 1px solid rgba(0,0,0,0.2); border-radius: 3px; box-shadow: 0 3px 8px rgba(0,0,0,0.2); z-index: 1000;'
                : 'position: absolute; top: 100%; right: 0; display: none; min-width: 220px; margin-top: 3px; background: #2b2b2b; color: #e0e0e0; border: 1px solid rgba(255,255,255,0.15); border-radius: 3px; box-shadow: 0 3px 8px rgba(0,0,0,0.5); z-index: 1000;'
        }, [
            E('button', {
                'class': 'btn',
                'click': function() { splitMenu.style.display = 'none'; saveAndRestartCore(); },
                'style': 'display: block; width: 100%; text-align: left; margin: 0; border: 0; border-radius: 0; background: transparent; padding: 8px 14px;' + (_light ? '' : ' color: #e0e0e0;'),
                'title': _('Full restart: stops and starts the Mihomo core, rebuilds firewall rules and refreshes subscription IPs. Active connections are dropped.')
            }, _('Save & Restart core'))
        ]);

        const splitContainer = E('div', {
            'class': 'ssclash-split-btn',
            'style': 'display: inline-flex; align-items: stretch; position: relative;'
        }, [
            E('button', {
                'class': 'btn',
                'click': saveAndReloadConfig,
                'style': 'margin: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: 0;',
                'title': _('Reload configuration via Mihomo API — active connections are preserved. Firewall rules are NOT rebuilt; use "Save & Restart core" when changing external-controller / tproxy-port / tun / fake-ip-filter-mode / proxy mode.')
            }, _('Save & Reload config')),
            E('button', {
                'class': 'btn',
                'style': 'margin: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; padding-left: 10px; padding-right: 10px;',
                'aria-haspopup': 'true',
                'aria-label': _('More actions'),
                'click': function(ev) {
                    ev.stopPropagation();
                    splitMenu.style.display = (splitMenu.style.display === 'block') ? 'none' : 'block';
                }
            }, '\u25BE'),
            splitMenu
        ]);

        document.addEventListener('click', function(ev) {
            if (!splitContainer.contains(ev.target)) splitMenu.style.display = 'none';
        });

        const dot = () => E('span', { 'style': 'margin: 0 6px; opacity: 0.35;' }, '\u00B7');

        const versionFooter = E('div', {
            'id': 'ssclash-version-footer',
            'style': 'margin-top: 20px; padding: 10px 0; border-top: 1px solid rgba(127,127,127,0.15); text-align: center; font-size: 11px; color: #999;'
        }, [
            E('span', {}, 'SSClash PARTY ' + SSCLASH_VERSION),
            dot(),
            E('span', {}, [
                'downstream by ',
                E('a', { 'href': SSCLASH_MAINTAINER_URL, 'target': '_blank', 'rel': 'noopener' }, 'ponkcore')
            ]),
            dot(),
            E('span', {}, [
                'based on ',
                E('a', { 'href': SSCLASH_UPSTREAM_URL, 'target': '_blank', 'rel': 'noopener' }, 'SSClash'),
                ' by ',
                E('a', { 'href': SSCLASH_AUTHOR_URL, 'target': '_blank', 'rel': 'noopener' }, 'ZeroChaos')
            ]),
            dot(),
            E('a', { 'href': SSCLASH_DONATE_URL, 'target': '_blank', 'rel': 'noopener' }, _('Donate')),
            dot(),
            E('span', { 'id': 'ssclash-update-status' }, '\u2026')
        ]);

        const view = E([
            E('div', {
                'style': 'margin-bottom: 20px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px;'
            }, [
                E('button', {
                    'class': 'btn',
                    'click': openDashboard,
                    'style': 'margin: 0;'
                }, _('Open Dashboard')),

                (startStopButton = E('button', {
                    'class': 'btn',
                    'click': toggleService,
                    'style': 'margin: 0;'
                }, running ? _('Stop Service') : _('Start Service'))),

                E('span', {
                    'class': 'label',
                    'style': `padding: 4px 10px; border-radius: 3px; font-size: 12px; color: white; background-color: ${running ? '#5cb85c' : '#d9534f'}; margin: 0;`
                }, running ? _('Clash is running') : _('Clash stopped'))
            ]),
            managedProfileCard,
            E('h2', _('Clash Configuration')),
            (configDescription = E('p', { 'class': 'cbi-section-descr' }, '')),
            E('div', {
                'id': 'editor',
                'style': 'width: 100%; height: 640px; margin-bottom: 15px;'
            }),
            (manualActions = E('div', {
                'style': 'display: flex; justify-content: center; gap: 8px; margin-top: 15px; margin-bottom: 20px;'
            }, [
                E('button', {
                    'class': 'btn',
                    'click': saveAndValidateOnly,
                    'title': _('Save and validate the YAML without starting or reloading the Clash service.')
                }, _('Save & Validate only')),
                splitContainer
            ])),
            versionFooter
        ]);

        initializeAceEditor(config, sourceModeSelect.value !== 'manual').then(updateSourceVisibility);

        (async function updateVersionFooter() {
            const status = view.querySelector('#ssclash-update-status');
            if (!status) return;

            const latest = await getLatestSSClashRelease();
            if (!latest) {
                status.textContent = _('update check failed');
                return;
            }

            if (cmpSemver(latest.version, SSCLASH_VERSION) > 0) {
                status.textContent = '';
                status.appendChild(E('a', {
                    'href': latest.url,
                    'target': '_blank',
                    'rel': 'noopener'
                }, latest.version + ' \u2191'));
            } else {
                status.textContent = '\u2713';
            }
        })();

        return view;
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
