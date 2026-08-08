'use strict';
'require baseclass';
'require fs';
'require rpc';
'require uci';
'require ui';
'require view.ssclash.utils';

const ROUTER_HELPER = '/usr/libexec/ssclash-router-integration';

const callUciCommit = rpc.declare({
    object: 'uci',
    method: 'commit',
    params: [ 'config' ],
    reject: true
});

function parseJSON(text) {
    try {
        const value = JSON.parse(String(text || '').trim());
        return value && typeof value === 'object' ? value : {};
    } catch (_error) {
        return {};
    }
}

function input(type, value, extra) {
    const attributes = Object.assign({
        'class': 'cbi-input-text',
        'type': type,
        'style': 'width: 100%; max-width: 420px;'
    }, extra || {});
    const element = E('input', attributes);
    if (type === 'checkbox') element.checked = value === true;
    else element.value = value == null ? '' : value;
    return element;
}

function fieldRow(label, control, description) {
    return E('div', {
        'style': 'display: grid; grid-template-columns: minmax(170px, 230px) minmax(260px, 1fr); gap: 8px 14px; align-items: start; margin: 9px 0;'
    }, [
        E('label', { 'style': 'padding-top: 6px; font-weight: 600;' }, label),
        E('div', {}, [
            control,
            description ? E('div', {
                'class': 'cbi-section-descr',
                'style': 'margin-top: 4px; font-size: 11px;'
            }, description) : ''
        ])
    ]);
}

function select(value, choices) {
    const element = E('select', {
        'class': 'cbi-input-select',
        'style': 'width: 100%; max-width: 420px;'
    }, choices.map(function(choice) {
        return E('option', { 'value': choice[0] }, choice[1]);
    }));
    element.value = value;
    return element;
}

return baseclass.extend({
    load: function() {
        view_ssclash_utils.bumpRpcTimeout();
        try {
            if (L.env && (!(L.env.rpctimeout > 0) || L.env.rpctimeout < 120)) {
                L.env.rpctimeout = 120;
            }
        } catch (_error) {}
        return uci.load('ssclash_profile');
    },

    render: function() {
        const get = function(option, fallback) {
            const value = uci.get('ssclash_profile', 'router', option);
            return value == null || value === '' ? fallback : value;
        };

        const dnsMode = select(get('dns_mode', 'redir-host'), [
            [ 'redir-host', _('Redir-host') ],
            [ 'fake-ip', _('Fake-IP') ]
        ]);
        const dnsListen = input('text', get('dns_listen', '127.0.0.1:7874'), {
            'placeholder': '127.0.0.1:7874'
        });
        const fakeRange = input('text', get('fake_ip_range', '198.18.0.1/16'), {
            'placeholder': '198.18.0.1/16'
        });
        const fakeFilterMode = select(get('fake_ip_filter_mode', 'blacklist'), [
            [ 'blacklist', _('Blacklist: excluded names use real IPs') ],
            [ 'whitelist', _('Whitelist: only listed names use fake IPs') ]
        ]);
        const storedFilters = get('fake_ip_filter', [ '*.lan', '*.local', 'panel.router' ]);
        const fakeFilters = E('textarea', {
            'class': 'cbi-input-textarea',
            'rows': '8',
            'spellcheck': 'false',
            'style': 'width: 100%; max-width: 620px; font-family: monospace;'
        }, Array.isArray(storedFilters) ? storedFilters.join('\n') : String(storedFilters).split(/\s+/).join('\n'));
        const storeFakeIP = input('checkbox', get('store_fake_ip', '1') === '1');

        const fakeSettings = E('div', {
            'style': 'margin: 12px 0; padding: 12px 14px; border: 1px solid rgba(127,127,127,.25); border-radius: 5px;'
        }, [
            E('h3', { 'style': 'margin-top: 0;' }, _('Fake-IP compatibility wizard')),
            E('p', { 'class': 'cbi-section-descr' }, _(
                'PARTY checks the range against connected routes, verifies required local-name exclusions, validates Mihomo, and uses guarded restart with rollback before making Fake-IP active.'
            )),
            fieldRow(_('Fake-IP range'), fakeRange, _('Use a dedicated IPv4 range that does not overlap LAN, VPN, or routed networks.')),
            fieldRow(_('Filter behavior'), fakeFilterMode),
            fieldRow(_('Compatibility filters'), fakeFilters, _('One domain pattern per line. *.lan, *.local, and the PARTY panel hostname are mandatory safety exclusions.')),
            fieldRow(_('Persist mappings'), E('label', {
                'style': 'display: inline-flex; gap: 8px; align-items: center;'
            }, [ storeFakeIP, E('span', {}, _('Keep fake-IP mappings across restarts')) ]))
        ]);

        const proxyMode = select(get('proxy_mode', 'tproxy'), [
            [ 'tproxy', _('TPROXY (recommended)') ],
            [ 'tun', _('TUN') ],
            [ 'mixed', _('Mixed: TCP TPROXY + UDP TUN') ]
        ]);
        const tproxyPort = input('number', get('tproxy_port', '7894'), {
            'min': '1024', 'max': '65535', 'step': '1'
        });
        const routingMark = input('number', get('routing_mark', '2'), {
            'min': '2', 'max': '65535', 'step': '1'
        });
        const tunStack = select(get('tun_stack', 'system'), [
            [ 'system', 'system' ],
            [ 'gvisor', 'gvisor' ],
            [ 'mixed', 'mixed' ]
        ]);
        const ipv6Enabled = input('checkbox', false, { 'disabled': true });

        const controllerMode = select(get('controller_mode', 'auto'), [
            [ 'auto', _('Automatic LAN address') ],
            [ 'custom', _('Custom private IPv4 address') ]
        ]);
        const controllerHost = input('text', get('controller_host', ''), {
            'placeholder': '192.168.1.1'
        });
        const controllerPort = input('number', get('controller_port', '9090'), {
            'min': '1024', 'max': '65535', 'step': '1'
        });
        const rotateSecret = input('checkbox', false);
        const panelEnabled = input('checkbox', get('panel_enabled', '0') === '1');
        const panelHostname = input('text', get('panel_hostname', 'panel.router'), {
            'placeholder': 'panel.router'
        });

        const updateVisibility = function() {
            fakeSettings.style.display = dnsMode.value === 'fake-ip' ? 'block' : 'none';
            const tunVisible = proxyMode.value === 'tun' || proxyMode.value === 'mixed';
            tunStack.closest('div[style*="grid-template-columns"]').style.display = tunVisible ? 'grid' : 'none';
            controllerHost.closest('div[style*="grid-template-columns"]').style.display =
                controllerMode.value === 'custom' ? 'grid' : 'none';
            panelHostname.disabled = !panelEnabled.checked;
        };
        dnsMode.addEventListener('change', updateVisibility);
        proxyMode.addEventListener('change', updateVisibility);
        controllerMode.addEventListener('change', updateVisibility);
        panelEnabled.addEventListener('change', updateVisibility);

        const collect = function() {
            const filters = fakeFilters.value.split(/\r?\n/).map(function(line) {
                return line.trim();
            }).filter(Boolean);
            const port = Number.parseInt(tproxyPort.value, 10);
            const mark = Number.parseInt(routingMark.value, 10);
            const apiPort = Number.parseInt(controllerPort.value, 10);
            const listenerPort = Number.parseInt(dnsListen.value.trim().split(':').pop(), 10);
            const hostname = panelHostname.value.trim().toLowerCase();
            if (!/^127\.\d+\.\d+\.\d+:\d+$/.test(dnsListen.value.trim())) {
                throw new Error(_('DNS listener must use a loopback IPv4 address and port.'));
            }
            if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
                !Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535 ||
                !Number.isInteger(listenerPort) || apiPort === listenerPort ||
                (proxyMode.value !== 'tun' && (port === apiPort || port === listenerPort))) {
                throw new Error(_('TPROXY, controller, and DNS listener ports must be different valid integers.'));
            }
            if (!Number.isInteger(mark) || mark < 2 || mark > 65535 || mark === 3) {
                throw new Error(_('Routing mark must be 2 or an integer from 4 through 65535.'));
            }
            if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname) || hostname.includes('..')) {
                throw new Error(_('Panel hostname is invalid.'));
            }
            if (dnsMode.value === 'fake-ip' && (!filters.length || filters.some(function(item) {
                return /\s/.test(item) || item.length > 255;
            }))) {
                throw new Error(_('Fake-IP filters must contain one non-empty pattern per line without spaces.'));
            }
            return {
                dns_mode: dnsMode.value,
                dns_listen: dnsListen.value.trim(),
                fake_ip_range: fakeRange.value.trim(),
                fake_ip_filter_mode: fakeFilterMode.value,
                fake_ip_filter: filters,
                store_fake_ip: storeFakeIP.checked ? '1' : '0',
                proxy_mode: proxyMode.value,
                tproxy_port: String(port),
                routing_mark: String(mark),
                tun_stack: tunStack.value,
                ipv6_enabled: '0',
                controller_mode: controllerMode.value,
                controller_host: controllerHost.value.trim(),
                controller_port: String(apiPort),
                panel_enabled: panelEnabled.checked ? '1' : '0',
                panel_hostname: hostname,
                rotate_controller_secret: rotateSecret.checked ? '1' : '0'
            };
        };

        const stage = async function(settings) {
            if (uci.get('ssclash_profile', 'pending')) {
                uci.remove('ssclash_profile', 'pending');
            }
            uci.add('ssclash_profile', 'router', 'pending');
            Object.keys(settings).forEach(function(option) {
                uci.set('ssclash_profile', 'pending', option, settings[option]);
            });
            await uci.save();
            await callUciCommit('ssclash_profile');
        };

        const runApply = async function(button) {
            button.disabled = true;
            try {
                await stage(collect());
                let checkResult = await fs.exec(ROUTER_HELPER, [ 'preflight' ]);
                let check = parseJSON(checkResult.stdout);
                if (checkResult.code !== 0 && Number(check.corrections || 0) > 0) {
                    const accepted = window.confirm(_(
                        'Fake-IP is missing mandatory local compatibility filters. Add PARTY safe defaults and run the checks again?'
                    ));
                    if (!accepted) throw new Error(check.message || _('Compatibility corrections were declined.'));
                    checkResult = await fs.exec(ROUTER_HELPER, [ 'correct' ]);
                    check = parseJSON(checkResult.stdout);
                }
                if (checkResult.code !== 0 || check.ok !== true) {
                    throw new Error((check.message || _('Compatibility checks failed.')) +
                        ' ' + _('Blockers: %s').format(check.blockers || 1));
                }
                if (Number(check.warnings || 0) > 0 && !window.confirm(_(
                    'Compatibility checks returned %s warning(s). Continue with guarded activation?'
                ).format(check.warnings))) {
                    throw new Error(_('Activation was cancelled.'));
                }

                ui.addNotification(null, E('p', _(
                    'Generating and validating the router overlay. Critical changes use guarded restart and automatic rollback…'
                )), 'info');
                const result = await fs.exec(ROUTER_HELPER, [ 'apply' ]);
                const status = parseJSON(result.stdout);
                if (result.code !== 0) {
                    throw new Error(status.message || _('Router Integration activation failed and the previous settings were restored.'));
                }
                ui.addNotification(null, E('p', _(
                    'Router Integration settings are active and passed runtime health checks.'
                )), 'info');
                window.setTimeout(function() { window.location.reload(); }, 1200);
            } catch (error) {
                ui.addNotification(null, E('p', _('Unable to apply Router Integration: %s').format(error.message)), 'error');
            } finally {
                button.disabled = false;
            }
        };

        const advanced = E('details', { 'style': 'margin-top: 16px;' }, [
            E('summary', { 'style': 'font-weight: 600; cursor: pointer;' }, _('Advanced router settings')),
            E('div', {
                'style': 'margin-top: 10px; padding: 10px 14px; border-left: 4px solid #f0ad4e; background: rgba(240,173,78,.10);'
            }, _('These values affect firewall rules, DNS, and controller access. Invalid combinations can interrupt connectivity; PARTY validates and rolls them back automatically.')),
            fieldRow(_('Transparent proxy mode'), proxyMode),
            fieldRow(_('TPROXY port'), tproxyPort),
            fieldRow(_('Routing mark'), routingMark, _('Marks 1 and 3 are reserved internally.')),
            fieldRow(_('TUN stack'), tunStack),
            fieldRow(_('IPv6 transparent routing'), E('label', {
                'style': 'display: inline-flex; gap: 8px; align-items: center;'
            }, [ ipv6Enabled, E('span', {}, _('Unavailable until the PARTY firewall backend has complete IPv6 leak protection')) ])),
            fieldRow(_('Controller address'), controllerMode),
            fieldRow(_('Custom controller IPv4'), controllerHost),
            fieldRow(_('Controller port'), controllerPort),
            fieldRow(_('Controller secret'), E('label', {
                'style': 'display: inline-flex; gap: 8px; align-items: center;'
            }, [ rotateSecret, E('span', {}, _('Rotate the secret during this activation (the value is never displayed)')) ])),
            fieldRow(_('Dashboard entry'), E('div', {}, [
                E('a', {
                    'class': 'btn',
                    'href': '/party/'
                }, _('Open /party/ dashboard entry')),
                E('p', {}, _('This DNS-independent address uses the current router IP, LuCI login, and no visible port.'))
            ])),
            fieldRow(_('Optional DNS alias'), E('label', {
                'style': 'display: inline-flex; gap: 8px; align-items: center;'
            }, [ panelEnabled, E('span', {}, _('Also publish a local hostname through dnsmasq')) ])),
            fieldRow(_('Optional panel hostname'), panelHostname, _('Browsers or Secure DNS may treat local names as searches. Prefer ROUTER_IP/party. HTTP is LAN-local and browsers will label it Not secure.'))
        ]);

        const applyButton = E('button', {
            'class': 'btn cbi-button-positive',
            'type': 'button',
            'click': function() { runApply(applyButton); }
        }, _('Check compatibility & apply'));

        const page = E('div', {}, [
            E('h2', {}, _('Router Integration')),
            E('p', { 'class': 'cbi-section-descr' }, _(
                'These settings belong to the router, not to a subscription. Every managed subscription or proxy-link profile receives the same protected overlay. Manual YAML remains authoritative for its own runtime settings.'
            )),
            fieldRow(_('DNS mode'), dnsMode, _('Subscriptions cannot change this selection. Redir-host keeps real DNS answers; Fake-IP enables the compatibility wizard below.')),
            fieldRow(_('DNS listener'), dnsListen, _('Upstream resolvers still come from the active policy or PARTY template.')),
            fakeSettings,
            advanced,
            E('div', { 'style': 'margin-top: 18px;' }, [ applyButton ])
        ]);
        window.setTimeout(updateVisibility, 0);
        return page;
    }
});
