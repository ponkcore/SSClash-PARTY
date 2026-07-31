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
const SSCLASH_MANAGED_PROFILE_UI = '1.0.0';

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

function computeUiPath(externalUiName, externalUi) {
    if (externalUiName) {
        const name = externalUiName.replace(/(^\/+|\/+$)/g, '');
        return `/${name}/`;
    }
    if (externalUi && !/[\/\\\.]/.test(externalUi)) {
        const name = externalUi.trim();
        return `/${name}/`;
    }
    return '/ui/';
}

async function openDashboard() {
    try {
        if (!(await getServiceStatus())) {
            ui.addNotification(null, E('p', _('Service is not running.')), 'error');
            return;
        }

        const config = await fs.read('/opt/clash/config.yaml');
        const ec = parseYamlValue(config, 'external-controller');
        const ecTls = parseYamlValue(config, 'external-controller-tls');
        const secret = parseYamlValue(config, 'secret');
        const externalUi = parseYamlValue(config, 'external-ui');
        const externalUiName = parseYamlValue(config, 'external-ui-name');

        const baseHost = window.location.hostname;
        const basePort = '9090';
        const useTls = !!ecTls;

        const { host, port } = normalizeHostPortFromAddr(useTls ? ecTls : ec, baseHost, basePort);
        const scheme = useTls ? 'https:' : 'http:';
        const uiPath = computeUiPath(externalUiName, externalUi);

        const qp = new URLSearchParams();
        if (secret) qp.set('secret', secret);
        qp.set('hostname', host);
        qp.set('port', port);
        const url = `${scheme}//${hostForUrl(host)}:${port}${uiPath}#/setup?${qp.toString()}`;

        const newWindow = window.open(url, '_blank');
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

async function initializeAceEditor(content) {
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
        wrap: true
    });
}

// =============================================================================
// SECTION: SSClash version / update footer helpers
// =============================================================================

// Keep in sync with luci-app-ssclash/Makefile PKG_VERSION
const SSCLASH_VERSION = '4.7.0';

const SSCLASH_REPO = 'zerolabnet/SSClash';
const SSCLASH_RELEASES_URL = 'https://github.com/' + SSCLASH_REPO + '/releases';
const SSCLASH_LATEST_API  = 'https://api.github.com/repos/' + SSCLASH_REPO + '/releases/latest';
const SSCLASH_AUTHOR_URL  = 'https://zerolab.net';
const SSCLASH_DONATE_URL  = 'https://zerolab.net/donate/';

function parseSemver(s) {
    const m = (s || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
}

function cmpSemver(a, b) {
    const pa = parseSemver(a), pb = parseSemver(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
}

async function getLatestSSClashRelease() {
    try {
        const resp = await fetch(SSCLASH_LATEST_API);
        if (!resp.ok) return null;
        const d = await resp.json();
        if (d.prerelease) return null;
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
            L.resolveDefault(fs.read(PROFILE_STATUS_FILE), '')
        ]);
    },
    render: async function(data) {
        const config = data[0];
        let profileStatus = parseProfileStatus(data[2]);
        const running = await getServiceStatus();
        const profileURL = uci.get('ssclash_profile', 'main', 'url') || '';
        const profileInterval = uci.get('ssclash_profile', 'main', 'interval') || '3600';
        const profileEnabled = uci.get('ssclash_profile', 'main', 'enabled') === '1';
        managedProfileConfigured = !!profileURL;

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
        subscriptionInput.value = profileURL;

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
        intervalInput.value = profileInterval;

        const autoUpdateInput = E('input', {
            'type': 'checkbox'
        });
        autoUpdateInput.checked = profileEnabled;

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
            if (summary) {
                metrics.push(
                    _('Nodes: %s').format(summary.inline_proxies || 0),
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
        const setProfileBusy = function(busy) {
            profileButtons.forEach(function(button) {
                button.disabled = busy;
            });
            subscriptionInput.disabled = busy;
            intervalInput.disabled = busy;
            autoUpdateInput.disabled = busy;
            showSubscriptionButton.disabled = busy;
            if (startStopButton) startStopButton.disabled = busy;
        };

        const collectProfileSettings = function() {
            const url = subscriptionInput.value.trim();
            const interval = Number.parseInt(intervalInput.value, 10);
            const enabled = autoUpdateInput.checked;

            if (url && (!/^https:\/\/[^\s'"\\]+$/i.test(url) || url.length > 2048)) {
                throw new Error(_('The subscription must be a valid HTTPS URL without spaces.'));
            }
            if (enabled && !url) {
                throw new Error(_('Enter a subscription URL before enabling automatic updates.'));
            }
            if (!Number.isInteger(interval) || interval < 300 || interval > 604800) {
                throw new Error(_('Update interval must be between 300 and 604800 seconds.'));
            }
            return {
                url: url,
                interval: String(interval),
                enabled: enabled
            };
        };

        const saveProfileSettings = async function(showNotification) {
            const settings = collectProfileSettings();

            uci.set('ssclash_profile', 'main', 'url', settings.url);
            uci.set('ssclash_profile', 'main', 'interval', settings.interval);
            uci.set('ssclash_profile', 'main', 'enabled', settings.enabled ? '1' : '0');
            await uci.save();
            await callUciCommit('ssclash_profile');

            let result;
            if (settings.enabled) {
                result = await fs.exec(PROFILE_INIT, ['enable']);
                if (result.code === 0) {
                    result = await fs.exec(PROFILE_INIT, ['restart']);
                }
            } else {
                result = await fs.exec(PROFILE_INIT, ['stop']);
                if (result.code === 0) {
                    result = await fs.exec(PROFILE_INIT, ['disable']);
                }
            }
            if (result.code !== 0) {
                throw new Error(_('The managed update service could not be reconfigured.'));
            }

            managedProfileConfigured = !!settings.url;
            if (showNotification) {
                ui.addNotification(null, E('p',
                    _('Managed profile settings saved.')
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
                renderProfileStatus({
                    state: 'working',
                    message: action === 'sync-start'
                        ? _('Downloading, validating and starting with rollback protection…')
                        : _('Downloading and validating the managed profile…'),
                    time: Math.floor(Date.now() / 1000)
                });

                const result = await fs.exec(PROFILE_HELPER, [action]);
                const status = await refreshProfileStatus(result.stdout);
                if (result.code !== 0) {
                    throw new Error(status.message || _('Managed profile operation failed.'));
                }

                ui.addNotification(null, E('p',
                    action === 'sync-start'
                        ? _('Managed profile is active and passed all health checks.')
                        : _('Managed profile was synchronized successfully.')
                ), 'info');

                try {
                    const updatedConfig = await fs.read('/opt/clash/config.yaml');
                    if (editor && updatedConfig) {
                        editor.setValue(updatedConfig);
                        editor.clearSelection();
                    }
                } catch (_e) {}

                if (action === 'sync-start' &&
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
                }
            }
        }, _('Save settings'));
        const syncProfileButton = E('button', {
            'class': 'btn',
            'click': function() {
                runProfileAction('sync');
            }
        }, _('Sync now'));
        const startManagedButton = E('button', {
            'class': 'btn cbi-button-positive',
            'click': function() {
                runProfileAction('sync-start');
            }
        }, _('Sync & guarded start'));
        profileButtons.push(saveProfileButton, syncProfileButton, startManagedButton);

        const managedProfileCard = E('div', {
            'id': 'ssclash-managed-profile',
            'data-version': SSCLASH_MANAGED_PROFILE_UI,
            'style': 'margin: 0 0 22px; padding: 16px; border: 1px solid rgba(127,127,127,0.28); border-radius: 5px;'
        }, [
            E('h2', { 'style': 'margin-top: 0;' }, _('Managed Full Profile')),
            E('p', { 'class': 'cbi-section-descr' }, _(
                'Paste a full Mihomo or Remnawave subscription URL. Nodes, groups, rule providers and rules are taken from the remote profile; router-critical TProxy, DNS and controller settings remain protected locally.'
            )),
            E('div', {
                'style': 'display: grid; grid-template-columns: minmax(150px, 210px) minmax(260px, 1fr); gap: 10px 14px; align-items: center;'
            }, [
                E('label', { 'for': 'ssclash-managed-subscription' }, _('Subscription URL')),
                E('div', {
                    'style': 'display: flex; align-items: center; gap: 8px;'
                }, [ subscriptionInput, showSubscriptionButton ]),
                E('label', {}, _('Update interval')),
                E('div', {
                    'style': 'display: flex; align-items: center; gap: 8px;'
                }, [
                    intervalInput,
                    E('span', { 'style': 'opacity: 0.75;' }, _('seconds (3600 = one hour)'))
                ]),
                E('label', {}, _('Automatic updates')),
                E('label', {
                    'style': 'display: inline-flex; align-items: center; gap: 8px;'
                }, [
                    autoUpdateInput,
                    E('span', {}, _('Download, validate and hot-reload on schedule'))
                ])
            ]),
            profileStatusBox,
            E('div', {
                'style': 'display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px;'
            }, [
                saveProfileButton,
                syncProfileButton,
                startManagedButton
            ]),
            E('p', {
                'style': 'margin: 12px 0 0; font-size: 11px; opacity: 0.72;'
            }, _(
                'Every candidate is checked with Mihomo before it replaces the active file. Running instances are hot-reloaded and rolled back if DNS, controller or proxy checks fail. Manual YAML edits are replaced at the next managed sync.'
            ))
        ]);

        const writeAndTestConfig = async function() {
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
            E('span', {}, 'SSClash v' + SSCLASH_VERSION),
            dot(),
            E('span', {}, [
                'by ',
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
            E('p', { 'class': 'cbi-section-descr' }, _(
                'Your current generated Clash config. If managed sync is enabled, manual edits are temporary and will be replaced on the next update.'
            )),
            E('div', {
                'id': 'editor',
                'style': 'width: 100%; height: 640px; margin-bottom: 15px;'
            }),
            E('div', {
                'style': 'display: flex; justify-content: center; gap: 8px; margin-top: 15px; margin-bottom: 20px;'
            }, [
                E('button', {
                    'class': 'btn',
                    'click': saveAndValidateOnly,
                    'title': _('Save and validate the YAML without starting or reloading the Clash service.')
                }, _('Save & Validate only')),
                splitContainer
            ]),
            versionFooter
        ]);

        initializeAceEditor(config);

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
