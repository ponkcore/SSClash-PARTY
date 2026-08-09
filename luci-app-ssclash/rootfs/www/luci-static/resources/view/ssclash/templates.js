'use strict';
'require view';
'require fs';
'require rpc';
'require uci';
'require ui';
'require view.ssclash.utils';

const TEMPLATE_HELPER = '/usr/libexec/ssclash-template-manager';
const TEMPLATE_INPUT_PREFIX = '/tmp/ssclash-party-template.';

const callUciCommit = rpc.declare({
    object: 'uci',
    method: 'commit',
    params: [ 'config' ],
    reject: true
});

view_ssclash_utils.bumpRpcTimeout();

function parseJSON(text) {
    try {
        const value = JSON.parse(String(text || '').trim());
        return value && typeof value === 'object' ? value : {};
    } catch (_error) {
        return {};
    }
}

async function templateCall(commandArguments) {
    const result = await fs.exec(TEMPLATE_HELPER, commandArguments);
    if (!result || result.code !== 0) {
        const message = String((result && (result.stderr || result.stdout)) || '').trim();
        throw new Error(message || _('Template operation failed.'));
    }
    const value = parseJSON(result.stdout);
    if (!Object.keys(value).length) throw new Error(_('Template manager returned an invalid response.'));
    return value;
}

function randomInputPath() {
    const bytes = new Uint8Array(12);
    window.crypto.getRandomValues(bytes);
    const suffix = Array.from(bytes).map(function(value) {
        return value.toString(16).padStart(2, '0');
    }).join('');
    return TEMPLATE_INPUT_PREFIX + suffix + '.yaml';
}

async function withTemplateInput(content, callback) {
    const path = randomInputPath();
    try {
        await fs.write(path, String(content || ''));
        const mode = await fs.exec('/bin/chmod', [ '600', path ]);
        if (mode.code !== 0) throw new Error(_('Unable to protect the temporary template input.'));
        return await callback(path);
    } finally {
        try { await fs.remove(path); } catch (_error) {}
    }
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value == null ? {} : value));
}

function textInput(value, extra) {
    const element = E('input', Object.assign({
        'class': 'cbi-input-text',
        'type': 'text',
        'style': 'width: 100%;'
    }, extra || {}));
    element.value = value == null ? '' : value;
    return element;
}

function selectInput(value, choices) {
    const element = E('select', {
        'class': 'cbi-input-select',
        'style': 'width: 100%;'
    }, choices.map(function(choice) {
        return E('option', { 'value': choice[0] }, choice[1]);
    }));
    element.value = value;
    return element;
}

function formRow(label, control, description) {
    return E('div', {
        'style': 'display: grid; grid-template-columns: minmax(130px, 190px) minmax(220px, 1fr); gap: 8px 12px; align-items: start; margin: 9px 0;'
    }, [
        E('label', { 'style': 'font-weight: 600; padding-top: 6px;' }, label),
        E('div', {}, [
            control,
            description ? E('div', { 'class': 'cbi-section-descr', 'style': 'margin-top: 4px;' }, description) : ''
        ])
    ]);
}

function safeIdentifier(value) {
    return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(value || ''));
}

function uniqueName(base, occupied) {
    let index = 1;
    let value = base;
    while (occupied.has(value)) value = base + '-' + index++;
    return value;
}

function summaryBadge(label, value) {
    return E('span', {
        'style': 'display: inline-block; margin: 2px 5px 2px 0; padding: 2px 7px; border-radius: 10px; background: rgba(127,127,127,.14); font-size: 11px;'
    }, '%s: %s'.format(label, value || 0));
}

function reportNode(report, changed) {
    report = report || {};
    const removed = Array.isArray(report.removed) ? report.removed : [];
    const adjusted = Array.isArray(report.adjusted) ? report.adjusted : [];
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    const entries = [];
    removed.forEach(function(item) {
        entries.push(E('li', {}, _('Removed %s — %s').format(item.path || '?', item.reason || '')));
    });
    adjusted.forEach(function(item) {
        entries.push(E('li', {}, _('Adjusted %s — %s').format(item.path || '?', item.reason || '')));
    });
    warnings.forEach(function(item) {
        entries.push(E('li', {}, _('Warning — %s').format(item)));
    });
    return E('div', {
        'style': 'margin: 12px 0; padding: 10px 12px; border-left: 4px solid ' +
            (entries.length ? '#f0ad4e' : '#5cb85c') + '; background: rgba(127,127,127,.08);'
    }, [
        E('strong', {}, entries.length
            ? _('PARTY sanitation report')
            : changed ? _('Canonical YAML generated') : _('Template is already canonical')),
        entries.length ? E('ul', { 'style': 'margin: 8px 0 0 18px;' }, entries) :
            E('p', { 'style': 'margin: 6px 0 0;' }, _('No unsafe or router-owned fields were found.'))
    ]);
}

function starterDocument() {
    return {
        'proxy-groups': [
            { name: 'PROXY', type: 'select', 'include-all': true }
        ],
        rules: [ 'MATCH,PROXY' ]
    };
}

function documentYAMLPlaceholder() {
    return '# Paste a complete Mihomo policy template here.\n' +
        '# PARTY will remove proxy credentials and Router Integration settings before saving.\n\n' +
        'proxy-groups:\n' +
        '  - name: PROXY\n' +
        '    type: select\n' +
        '    include-all: true\n\n' +
        'rules:\n' +
        '  - MATCH,PROXY\n';
}

function loadAce() {
    if (window.ace) return Promise.resolve();
    return new Promise(function(resolve, reject) {
        const existing = document.querySelector('script[src="/luci-static/resources/view/ssclash/ace/ace.js"]');
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = '/luci-static/resources/view/ssclash/ace/ace.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

function editorCard(title, body, actions) {
    return E('div', {
        'style': 'margin: 10px 0; padding: 12px; border: 1px solid rgba(127,127,127,.25); border-radius: 5px;'
    }, [
        E('div', { 'style': 'display: flex; gap: 8px; align-items: center; margin-bottom: 10px;' }, [
            E('strong', { 'style': 'flex: 1;' }, title),
            ...(actions || [])
        ]),
        body
    ]);
}

function smallButton(label, handler, className) {
    return E('button', {
        'class': className || 'btn',
        'type': 'button',
        'style': 'margin: 0;',
        'click': handler
    }, label);
}

function visualEditor(documentValue, legacyLists, onChange) {
    const root = E('div');
    let model = documentValue;

    function changed() {
        onChange(model);
    }

    function move(items, index, direction) {
        const target = index + direction;
        if (target < 0 || target >= items.length) return;
        const value = items[index];
        items[index] = items[target];
        items[target] = value;
        render();
        changed();
    }

    function renderGroups(container) {
        const groups = Array.isArray(model['proxy-groups']) ? model['proxy-groups'] : [];
        model['proxy-groups'] = groups;
        groups.forEach(function(group, index) {
            group = group && typeof group === 'object' ? group : {};
            groups[index] = group;
            const name = textInput(group.name || '');
            name.addEventListener('input', function() { group.name = name.value; changed(); });
            const type = selectInput(group.type || 'select', [
                [ 'select', 'select' ], [ 'url-test', 'url-test' ], [ 'fallback', 'fallback' ],
                [ 'load-balance', 'load-balance' ], [ 'relay', 'relay' ]
            ]);
            type.addEventListener('change', function() { group.type = type.value; changed(); });
            const proxies = E('textarea', {
                'class': 'cbi-input-textarea', 'rows': '3', 'style': 'width: 100%; font-family: monospace;',
                'placeholder': _('One template group or DIRECT/REJECT/PASS per line')
            }, Array.isArray(group.proxies) ? group.proxies.join('\n') : '');
            proxies.addEventListener('input', function() {
                const values = proxies.value.split(/\r?\n/).map(function(item) { return item.trim(); }).filter(Boolean);
                if (values.length) group.proxies = values;
                else delete group.proxies;
                changed();
            });
            const includeAll = E('input', { 'type': 'checkbox' });
            includeAll.checked = group['include-all'] === true;
            includeAll.addEventListener('change', function() { group['include-all'] = includeAll.checked; changed(); });
            const url = textInput(group.url || '', { 'placeholder': 'https://www.gstatic.com/generate_204' });
            url.addEventListener('input', function() {
                if (url.value.trim()) group.url = url.value.trim(); else delete group.url;
                changed();
            });
            const interval = textInput(group.interval == null ? '' : group.interval, { 'type': 'number', 'min': '1' });
            interval.addEventListener('input', function() {
                if (interval.value) group.interval = Number(interval.value); else delete group.interval;
                changed();
            });
            container.appendChild(editorCard(_('Group %s').format(index + 1), E('div', {}, [
                formRow(_('Name'), name),
                formRow(_('Type'), type),
                formRow(_('Static group choices'), proxies, _('Concrete node names are removed; active source nodes are added through Include all.')),
                formRow(_('Include all source nodes'), E('label', {}, [ includeAll, ' ', _('Enabled') ])),
                formRow(_('Health-check URL'), url),
                formRow(_('Interval (seconds)'), interval)
            ]), [
                smallButton('↑', function() { move(groups, index, -1); }),
                smallButton('↓', function() { move(groups, index, 1); }),
                smallButton(_('Delete'), function() { groups.splice(index, 1); render(); changed(); }, 'btn cbi-button-negative')
            ]));
        });
        container.appendChild(smallButton(_('Add proxy group'), function() {
            const occupied = new Set(groups.map(function(group) { return group.name; }));
            groups.push({ name: uniqueName('New Group', occupied), type: 'select', 'include-all': true });
            render(); changed();
        }, 'btn cbi-button-add'));
    }

    function renderProviders(container) {
        const providers = model['rule-providers'] && typeof model['rule-providers'] === 'object'
            ? model['rule-providers'] : {};
        model['rule-providers'] = providers;
        Object.keys(providers).forEach(function(initialName) {
            const provider = providers[initialName] && typeof providers[initialName] === 'object'
                ? providers[initialName] : {};
            providers[initialName] = provider;
            let currentName = initialName;
            const name = textInput(currentName);
            name.addEventListener('change', function() {
                const next = name.value.trim();
                if (!next || next.includes(',') || (next !== currentName && providers[next])) {
                    name.value = currentName;
                    ui.addNotification(null, E('p', _('Provider names must be non-empty and unique.')), 'error');
                    return;
                }
                if (next !== currentName) {
                    delete providers[currentName];
                    providers[next] = provider;
                    currentName = next;
                    changed();
                }
            });
            const type = selectInput(provider.type || 'http', [ [ 'http', 'HTTP (HTTPS URL)' ], [ 'inline', 'Inline list' ] ]);
            const behavior = selectInput(provider.behavior || 'classical', [
                [ 'domain', 'domain' ], [ 'ipcidr', 'ipcidr' ], [ 'classical', 'classical' ]
            ]);
            const format = selectInput(provider.format || 'mrs', [ [ 'mrs', 'mrs' ], [ 'yaml', 'yaml' ], [ 'text', 'text' ] ]);
            const url = textInput(provider.url || '', { 'placeholder': 'https://example.invalid/rules.mrs' });
            const interval = textInput(provider.interval == null ? '86400' : provider.interval, { 'type': 'number', 'min': '1' });
            const payload = E('textarea', {
                'class': 'cbi-input-textarea', 'rows': '7', 'style': 'width: 100%; font-family: monospace;',
                'placeholder': _('One inline rule-provider payload entry per line')
            }, Array.isArray(provider.payload) ? provider.payload.join('\n') : '');
            const httpRows = E('div', {}, [
                formRow(_('Format'), format), formRow(_('HTTPS URL'), url), formRow(_('Update interval'), interval)
            ]);
            const inlineRows = E('div', {}, [ formRow(_('Payload'), payload) ]);
            const updateType = function() {
                provider.type = type.value;
                httpRows.style.display = type.value === 'http' ? 'block' : 'none';
                inlineRows.style.display = type.value === 'inline' ? 'block' : 'none';
                if (type.value === 'http') {
                    delete provider.payload;
                } else {
                    delete provider.url; delete provider.interval; delete provider.format;
                }
                changed();
            };
            type.addEventListener('change', updateType);
            behavior.addEventListener('change', function() { provider.behavior = behavior.value; changed(); });
            format.addEventListener('change', function() { provider.format = format.value; changed(); });
            url.addEventListener('input', function() { provider.url = url.value.trim(); changed(); });
            interval.addEventListener('input', function() { provider.interval = Number(interval.value || 0); changed(); });
            payload.addEventListener('input', function() {
                provider.payload = payload.value.split(/\r?\n/).map(function(item) { return item.trim(); }).filter(Boolean);
                changed();
            });
            container.appendChild(editorCard(_('Rule provider: %s').format(initialName), E('div', {}, [
                formRow(_('Name'), name), formRow(_('Source type'), type), formRow(_('Behavior'), behavior),
                httpRows, inlineRows
            ]), [ smallButton(_('Delete'), function() { delete providers[currentName]; render(); changed(); }, 'btn cbi-button-negative') ]));
            window.setTimeout(updateType, 0);
        });
        container.appendChild(smallButton(_('Add rule provider'), function() {
            const name = uniqueName('provider', new Set(Object.keys(providers)));
            providers[name] = {
                type: 'inline', behavior: 'classical', payload: [ 'DOMAIN-SUFFIX,example.invalid' ]
            };
            render(); changed();
        }, 'btn cbi-button-add'));

        if (legacyLists.length) {
            const list = selectInput(legacyLists[0].name, legacyLists.map(function(item) {
                return [ item.name, '%s (%s)'.format(item.name, _('%s entries').format(item.entries)) ];
            }));
            const behavior = selectInput('classical', [ [ 'domain', 'domain' ], [ 'ipcidr', 'ipcidr' ], [ 'classical', 'classical' ] ]);
            const importButton = smallButton(_('Import as inline provider'), async function() {
                importButton.disabled = true;
                try {
                    const selected = legacyLists.find(function(item) { return item.name === list.value; });
                    if (!selected || !/^[A-Za-z0-9_.-]+\.txt$/.test(selected.name)) throw new Error(_('Legacy list name is invalid.'));
                    const content = await fs.read('/opt/clash/lst/' + selected.name);
                    const payload = String(content || '').split(/\r?\n/).map(function(line) { return line.trim(); })
                        .filter(function(line) { return line && !line.startsWith('#'); });
                    if (!payload.length) throw new Error(_('The selected legacy list is empty.'));
                    const base = selected.name.replace(/\.txt$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '') || 'legacy-list';
                    const providerName = uniqueName(base, new Set(Object.keys(providers)));
                    providers[providerName] = { type: 'inline', behavior: behavior.value, payload: payload };
                    render(); changed();
                    ui.addNotification(null, E('p', _(
                        'Imported as inline provider "%s". Add an ordered RULE-SET rule below to route it; the original legacy file was retained.'
                    ).format(providerName)), 'info');
                } catch (error) {
                    ui.addNotification(null, E('p', _('Unable to import legacy list: %s').format(error.message)), 'error');
                } finally {
                    importButton.disabled = false;
                }
            });
            container.appendChild(E('div', {
                'style': 'margin-top: 14px; padding: 12px; border: 1px dashed rgba(127,127,127,.45); border-radius: 5px;'
            }, [
                E('strong', {}, _('Import an unattached legacy list')),
                E('p', { 'class': 'cbi-section-descr' }, _(
                    'The old file is not automatically connected to a template. Importing copies its entries into a portable Mihomo inline provider.'
                )),
                formRow(_('Legacy file'), list), formRow(_('Behavior'), behavior), importButton
            ]));
        }
    }

    function renderRules(container) {
        const rules = Array.isArray(model.rules) ? model.rules : [];
        model.rules = rules;
        const structuredTypes = [
            'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
            'RULE-SET', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'DST-PORT',
            'SRC-PORT', 'GEOIP', 'GEOSITE', 'PROCESS-NAME', 'PROCESS-PATH',
            'NETWORK', 'MATCH'
        ];
        const groupNames = (Array.isArray(model['proxy-groups']) ? model['proxy-groups'] : [])
            .map(function(group) { return String((group && group.name) || '').trim(); }).filter(Boolean);
        const targetNames = groupNames.concat([ 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE' ])
            .filter(function(value, index, values) { return values.indexOf(value) === index; });
        const providerNames = Object.keys(model['rule-providers'] || {});

        function choiceList(values, current) {
            const result = values.slice();
            if (current && !result.includes(current)) result.push(current);
            return result.map(function(value) { return [ value, value ]; });
        }

        function parseStructuredRule(value) {
            const fields = String(value || '').split(',').map(function(field) { return field.trim(); });
            const type = String(fields[0] || '').toUpperCase();
            if (!structuredTypes.includes(type)) return { mode: 'RAW', raw: String(value || '') };
            if (type === 'MATCH' && fields.length === 2) {
                return { mode: type, payload: '', target: fields[1], noResolve: false };
            }
            if (type !== 'MATCH' && (fields.length === 3 || (fields.length === 4 && fields[3] === 'no-resolve'))) {
                return { mode: type, payload: fields[1], target: fields[2], noResolve: fields.length === 4 };
            }
            return { mode: 'RAW', raw: String(value || '') };
        }

        rules.forEach(function(rule, index) {
            const parsed = parseStructuredRule(rule);
            const type = selectInput(parsed.mode, structuredTypes.map(function(value) {
                return [ value, value ];
            }).concat([ [ 'RAW', _('Advanced raw rule') ] ]));
            const raw = textInput(parsed.raw || rule || '', {
                'style': 'width: 100%; font-family: monospace;',
                'placeholder': 'AND,((DOMAIN,example.com),(NETWORK,TCP)),PROXY'
            });
            let payload;
            if (parsed.mode === 'RULE-SET') {
                payload = selectInput(parsed.payload || providerNames[0] || '', choiceList(providerNames, parsed.payload));
            } else {
                payload = textInput(parsed.payload || '', {
                    'style': 'width: 100%; font-family: monospace;',
                    'placeholder': parsed.mode === 'DOMAIN-SUFFIX' ? 'example.com' : _('Rule value')
                });
            }
            const target = selectInput(parsed.target || groupNames[0] || 'DIRECT', choiceList(targetNames, parsed.target));
            const noResolve = E('input', { 'type': 'checkbox' });
            noResolve.checked = parsed.noResolve === true;
            const structured = E('div', {
                'style': 'display: grid; grid-template-columns: minmax(180px,1.4fr) minmax(150px,1fr) auto; gap: 6px; align-items: center;'
            }, [ payload, target, E('label', { 'style': 'white-space: nowrap;' }, [ noResolve, ' ', _('no-resolve') ]) ]);
            const editorLayout = E('div', {
                'style': 'display: grid; grid-template-columns: minmax(130px,.7fr) minmax(260px,2.4fr); gap: 6px; align-items: center;'
            }, [ type, parsed.mode === 'RAW' ? raw : structured ]);

            const updateRule = function() {
                if (type.value === 'RAW') {
                    rules[index] = raw.value.trim();
                } else if (type.value === 'MATCH') {
                    rules[index] = 'MATCH,' + target.value;
                } else {
                    rules[index] = type.value + ',' + payload.value.trim() + ',' + target.value +
                        (noResolve.checked ? ',no-resolve' : '');
                }
                changed();
            };
            type.addEventListener('change', function() {
                if (type.value === 'RAW') {
                    raw.value = rules[index] || '';
                } else {
                    const defaultPayload = type.value === 'RULE-SET'
                        ? (providerNames[0] || 'provider') : 'example.invalid';
                    rules[index] = type.value === 'MATCH'
                        ? 'MATCH,' + (groupNames[0] || 'DIRECT')
                        : type.value + ',' + defaultPayload + ',' + (groupNames[0] || 'DIRECT');
                }
                render(); changed();
            });
            raw.addEventListener('input', updateRule);
            payload.addEventListener('input', updateRule);
            payload.addEventListener('change', updateRule);
            target.addEventListener('change', updateRule);
            noResolve.addEventListener('change', updateRule);
            if (parsed.mode === 'MATCH') payload.style.display = 'none';

            container.appendChild(E('div', {
                'style': 'display: grid; grid-template-columns: 42px minmax(300px,1fr) auto auto auto; gap: 6px; align-items: center; margin: 7px 0; padding: 7px; border: 1px solid rgba(127,127,127,.16); border-radius: 4px;'
            }, [
                E('span', { 'style': 'text-align: right; opacity: .7;' }, String(index + 1)),
                editorLayout,
                smallButton('↑', function() { move(rules, index, -1); }),
                smallButton('↓', function() { move(rules, index, 1); }),
                smallButton(_('Delete'), function() { rules.splice(index, 1); render(); changed(); }, 'btn cbi-button-negative')
            ]));
        });
        container.appendChild(smallButton(_('Add rule'), function() {
            const fallbackIndex = rules.findIndex(function(rule) { return /^(MATCH|FINAL),/i.test(String(rule)); });
            const target = groupNames[0] || 'DIRECT';
            if (fallbackIndex >= 0) rules.splice(fallbackIndex, 0, 'DOMAIN-SUFFIX,example.invalid,' + target);
            else rules.push('MATCH,' + target);
            render(); changed();
        }, 'btn cbi-button-add'));
    }

    function render() {
        root.replaceChildren();
        const groups = E('div');
        const providers = E('div');
        const rules = E('div');
        renderGroups(groups);
        renderProviders(providers);
        renderRules(rules);
        root.appendChild(E('div', {}, [
            E('h3', {}, _('Proxy groups')), groups,
            E('h3', { 'style': 'margin-top: 24px;' }, _('Rule providers and local lists')), providers,
            E('h3', { 'style': 'margin-top: 24px;' }, _('Ordered rules')), rules
        ]));
    }

    render();
    return { node: root, getDocument: function() { return model; } };
}

return view.extend({
    load: function() {
        return Promise.all([
            L.resolveDefault(templateCall([ 'list' ]), { schema_version: 2, templates: [], legacy_lists: [] }),
            L.resolveDefault(uci.load('ssclash_profile'), null)
        ]);
    },

    render: function(data) {
        let catalog = data[0] || { templates: [], legacy_lists: [] };
        const legacyLists = Array.isArray(catalog.legacy_lists) ? catalog.legacy_lists : [];
        if (!Array.isArray(catalog.templates) || !catalog.templates.length) {
            ui.addNotification(null, E('p', _(
                'The template catalog is unavailable. No changes can be made until the PARTY template manager and built-in catalog are restored.'
            )), 'error');
        }

        const refresh = function() { window.location.reload(); };

        const useTemplate = async function(record, button) {
            button.disabled = true;
            try {
                uci.set('ssclash_profile', 'main', 'template_id', record.id);
                const active = uci.get('ssclash_profile', 'main', 'active_profile');
                if (active && uci.get('ssclash_profile', active)) {
                    uci.set('ssclash_profile', active, 'template_id', record.id);
                }
                await uci.save();
                await callUciCommit('ssclash_profile');
                ui.addNotification(null, E('p', _(
                    'Template "%s" is now selected. Automatic remote policy remains automatic; this template is used for proxy links, nodes-only responses, or when template policy is explicitly selected.'
                ).format(record.name || record.id)), 'info');
            } catch (error) {
                ui.addNotification(null, E('p', _('Unable to select template: %s').format(error.message)), 'error');
            } finally {
                button.disabled = false;
            }
        };

        const templateIsReferenced = function(id) {
            if ((uci.get('ssclash_profile', 'main', 'template_id') || 'russia') === id) return true;
            return uci.sections('ssclash_profile', 'subscription').some(function(section) {
                return (section.template_id || 'russia') === id;
            });
        };

        const deleteTemplate = function(record) {
            if (templateIsReferenced(record.id)) {
                ui.addNotification(null, E('p', _(
                    'This template is selected by Configuration. Select another template there before deleting it.'
                )), 'error');
                return;
            }
            ui.showModal(_('Delete template'), [
                E('p', {}, _(
                    'Delete "%s" from the active catalog? PARTY moves it to protected trash, so router recovery remains possible.'
                ).format(record.name || record.id)),
                E('div', { 'class': 'right' }, [
                    smallButton(_('Cancel'), ui.hideModal),
                    smallButton(_('Delete'), async function(event) {
                        event.currentTarget.disabled = true;
                        try {
                            await templateCall([ 'delete', record.id, String(record.revision) ]);
                            ui.hideModal();
                            refresh();
                        } catch (error) {
                            ui.addNotification(null, E('p', _('Unable to delete template: %s').format(error.message)), 'error');
                            event.currentTarget.disabled = false;
                        }
                    }, 'btn cbi-button-negative')
                ])
            ]);
        };

        const openEditor = async function(seed, options) {
            options = options || {};
            let record = seed;
            if (record.id && !options.newTemplate && !record.yaml) {
                try {
                    record = await templateCall([ 'get', record.id ]);
                } catch (error) {
                    ui.addNotification(null, E('p', _('Unable to load template: %s').format(error.message)), 'error');
                    return;
                }
            }
            record = deepClone(record || {});
            const readOnly = record.read_only === true && !options.clone;
            const revision = options.newTemplate || options.clone ? 0 : Number(record.revision || 0);
            const originalID = options.newTemplate || options.clone ? '' : record.id;
            let currentDocument = deepClone(record.document || starterDocument());
            let aceEditor = null;
            let visual = null;
            let mode = readOnly || options.yamlImport ? 'yaml' : 'visual';

            const idInput = textInput(options.clone ? '' : (record.id || ''), {
                'maxlength': '32', 'placeholder': 'my-template'
            });
            const nameInput = textInput(options.clone ? (record.name || record.id || '') + ' Copy' : (record.name || ''), { 'maxlength': '96' });
            const descriptionInput = E('textarea', {
                'class': 'cbi-input-textarea', 'rows': '2', 'maxlength': '512', 'style': 'width: 100%;'
            }, record.description || '');
            if (originalID) idInput.disabled = true;
            if (readOnly) {
                nameInput.disabled = true;
                descriptionInput.disabled = true;
            }
            const reportArea = E('div');
            const yamlPane = E('div', { 'style': 'display: none;' }, [
                E('div', { 'id': 'ssclash-party-template-editor', 'style': 'height: 520px; min-height: 260px; border-radius: 4px;' })
            ]);
            const visualPane = E('div', { 'style': 'display: none; max-height: 58vh; overflow: auto; padding-right: 5px;' });

            const updateModeButtons = function() {
                yamlPane.style.display = mode === 'yaml' ? 'block' : 'none';
                visualPane.style.display = mode === 'visual' ? 'block' : 'none';
            };

            const prepareContent = async function(content) {
                return withTemplateInput(content, function(path) {
                    return templateCall([ 'prepare', path ]);
                });
            };

            const applyPrepared = function(prepared) {
                currentDocument = deepClone(prepared.document || {});
                if (aceEditor) {
                    aceEditor.setValue(prepared.yaml || '', -1);
                    aceEditor.clearSelection();
                }
                reportArea.replaceChildren(reportNode(prepared.report, prepared.changed));
            };

            const rebuildVisual = function() {
                visualPane.replaceChildren();
                visual = visualEditor(currentDocument, legacyLists, function(value) {
                    currentDocument = value;
                });
                visualPane.appendChild(visual.node);
            };

            const switchToVisual = async function(button) {
                if (mode === 'visual') return;
                button.disabled = true;
                try {
                    const prepared = await prepareContent(aceEditor.getValue());
                    applyPrepared(prepared);
                    rebuildVisual();
                    mode = 'visual';
                    updateModeButtons();
                } catch (error) {
                    ui.addNotification(null, E('p', _('Cannot open visual editor: %s').format(error.message)), 'error');
                } finally {
                    button.disabled = false;
                }
            };

            const switchToYAML = async function(button) {
                if (mode === 'yaml') return;
                button.disabled = true;
                try {
                    const prepared = await prepareContent(JSON.stringify(currentDocument));
                    applyPrepared(prepared);
                    mode = 'yaml';
                    updateModeButtons();
                } catch (error) {
                    ui.addNotification(null, E('p', _('Cannot generate YAML: %s').format(error.message)), 'error');
                } finally {
                    button.disabled = false;
                }
            };

            const yamlButton = smallButton(_('YAML editor'), function() { switchToYAML(yamlButton); });
            const visualButton = smallButton(_('Visual editor'), function() { switchToVisual(visualButton); });
            visualButton.disabled = readOnly;
            const prepareButton = smallButton(_('Prepare & inspect'), async function() {
                prepareButton.disabled = true;
                try {
                    const content = mode === 'yaml' ? aceEditor.getValue() : JSON.stringify(currentDocument);
                    const prepared = await prepareContent(content);
                    applyPrepared(prepared);
                    if (mode === 'visual') rebuildVisual();
                } catch (error) {
                    ui.addNotification(null, E('p', _('Template preparation failed: %s').format(error.message)), 'error');
                } finally {
                    prepareButton.disabled = false;
                }
            });

            const saveButton = smallButton(_('Save template'), async function() {
                saveButton.disabled = true;
                try {
                    const id = idInput.value.trim();
                    const name = nameInput.value.trim();
                    if (!safeIdentifier(id)) throw new Error(_('ID must start with a lowercase letter or digit and contain at most 32 lowercase letters, digits, underscores, or hyphens.'));
                    if (!name) throw new Error(_('Template name is required.'));
                    const content = mode === 'yaml' ? aceEditor.getValue() : JSON.stringify(currentDocument);
                    const prepared = await prepareContent(content);
                    applyPrepared(prepared);
                    const changes = (prepared.report.removed || []).length + (prepared.report.adjusted || []).length;
                    if (changes && !window.confirm(_(
                        'PARTY made %s safety adjustment(s). Review the sanitation report in the editor, then press OK to save the shown canonical YAML.'
                    ).format(changes))) return;
                    const saved = await withTemplateInput(prepared.yaml, function(path) {
                        return templateCall([
                            'save', id, String(revision), name,
                            descriptionInput.value.trim(), path
                        ]);
                    });
                    ui.hideModal();
                    ui.addNotification(null, E('p', _(
                        'Template "%s" revision %s was validated by Mihomo and saved atomically.'
                    ).format(saved.name || id, saved.revision || '?')), 'info');
                    refresh();
                } catch (error) {
                    ui.addNotification(null, E('p', _('Unable to save template: %s').format(error.message)), 'error');
                } finally {
                    saveButton.disabled = false;
                }
            }, 'btn cbi-button-positive');

            const historyControls = [];
            if (!readOnly && revision > 0 && Array.isArray(record.history) && record.history.length) {
                const history = selectInput(String(record.history[0]), record.history.map(function(item) {
                    return [ String(item), _('Revision %s').format(item) ];
                }));
                const restore = smallButton(_('Restore as new revision'), async function() {
                    if (!window.confirm(_('Restore revision %s and keep the current version in history?').format(history.value))) return;
                    restore.disabled = true;
                    try {
                        const restored = await templateCall([ 'restore', record.id, history.value, String(revision) ]);
                        ui.hideModal();
                        ui.addNotification(null, E('p', _('Restored as revision %s.').format(restored.revision)), 'info');
                        refresh();
                    } catch (error) {
                        ui.addNotification(null, E('p', _('Unable to restore revision: %s').format(error.message)), 'error');
                        restore.disabled = false;
                    }
                });
                historyControls.push(E('div', {
                    'style': 'display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px;'
                }, [ E('strong', {}, _('History')), history, restore ]));
            }

            const modalBody = E('div', {}, [
                E('p', { 'class': 'cbi-section-descr' }, _(
                    'Templates contain routing policy only. PARTY supplies proxy nodes and enforces DNS mode, listeners, controller authentication, TPROXY/TUN, routing marks, IPv6, and provider cache paths separately.'
                )),
                formRow(_('Template ID'), idInput, originalID ? _('The persistent ID cannot be renamed.') : _('Lowercase, stable, and used by saved subscription profiles.')),
                formRow(_('Display name'), nameInput),
                formRow(_('Description'), descriptionInput),
                E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0;' }, [
                    yamlButton, visualButton, prepareButton
                ]),
                reportArea,
                yamlPane,
                visualPane,
                ...historyControls,
                E('div', { 'class': 'right', 'style': 'margin-top: 16px;' }, [
                    smallButton(_('Close'), ui.hideModal),
                    readOnly ? '' : saveButton
                ])
            ]);
            ui.showModal(readOnly ? _('View built-in template') : revision ? _('Edit template') : _('Create template'), [ modalBody ]);

            try {
                await loadAce();
                ace.config.set('basePath', '/luci-static/resources/view/ssclash/ace/');
                aceEditor = ace.edit('ssclash-party-template-editor');
                aceEditor.setTheme('ace/theme/tomorrow_night_bright');
                aceEditor.session.setMode('ace/mode/yaml');
                aceEditor.setOptions({ fontSize: '12px', showPrintMargin: false, wrap: true, readOnly: readOnly });
                aceEditor.setValue(options.yamlImport ? documentYAMLPlaceholder() : (record.yaml || JSON.stringify(currentDocument, null, 2)), -1);
                if (mode === 'visual') rebuildVisual();
                updateModeButtons();
            } catch (error) {
                ui.addNotification(null, E('p', _('Unable to initialize template editor: %s').format(error.message)), 'error');
            }
        };

        const cards = (Array.isArray(catalog.templates) ? catalog.templates : []).map(function(record) {
            const card = E('div', {
                'style': 'padding: 14px; border: 1px solid rgba(127,127,127,.25); border-radius: 6px; background: rgba(127,127,127,.04);'
            });
            const useButton = smallButton(_('Select'), function() { useTemplate(record, useButton); }, 'btn cbi-button-positive');
            const actions = [
                useButton,
                smallButton(record.read_only ? _('View') : _('Edit'), function() { openEditor(record); }),
                smallButton(_('Clone'), function() { openEditor(record, { clone: true }); })
            ];
            if (!record.read_only) actions.push(smallButton(_('Delete'), function() { deleteTemplate(record); }, 'btn cbi-button-negative'));
            card.appendChild(E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start;' }, [
                E('div', { 'style': 'flex: 1; min-width: 220px;' }, [
                    E('h3', { 'style': 'margin: 0 0 4px;' }, record.name || record.id),
                    E('div', { 'style': 'font-family: monospace; font-size: 11px; opacity: .65;' }, record.id),
                    E('p', { 'class': 'cbi-section-descr', 'style': 'margin: 8px 0;' }, record.description || _('No description.')),
                    E('div', {}, [
                        summaryBadge(_('Groups'), record.summary && record.summary.groups),
                        summaryBadge(_('Providers'), record.summary && record.summary.rule_providers),
                        summaryBadge(_('Inline lists'), record.summary && record.summary.inline_lists),
                        summaryBadge(_('Rules'), record.summary && record.summary.rules)
                    ]),
                    E('div', { 'style': 'margin-top: 7px; font-size: 11px;' }, record.read_only
                        ? _('Built in · version %s · read-only').format(record.version || 1)
                        : _('Custom · revision %s · saved %s').format(record.revision || 1, record.updated_at || ''))
                ]),
                E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 6px;' }, actions)
            ]));
            return card;
        });

        const legacySection = legacyLists.length ? E('div', {
            'style': 'margin-top: 24px; padding: 14px; border: 1px dashed rgba(127,127,127,.45); border-radius: 6px;'
        }, [
            E('h3', { 'style': 'margin-top: 0;' }, _('Unattached legacy lists')),
            E('p', { 'class': 'cbi-section-descr' }, _(
                'These files came from the former Rulesets page and are preserved for compatibility. Open a custom template in the visual editor to copy one into a portable inline rule-provider. PARTY never deletes the original automatically.'
            )),
            E('ul', {}, legacyLists.map(function(item) {
                return E('li', {}, '%s — %s'.format(item.name, _('%s entries').format(item.entries)));
            }))
        ]) : '';

        return E('div', {}, [
            E('div', { 'class': 'cbi-section' }, [
                E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 10px; align-items: center;' }, [
                    E('div', { 'style': 'flex: 1; min-width: 240px;' }, [
                        E('h2', { 'style': 'margin-bottom: 4px;' }, _('Templates')),
                        E('p', { 'class': 'cbi-section-descr' }, _(
                            'Create reusable routing policies with canonical YAML or a visual editor. Subscription nodes and Router Integration remain isolated from every template.'
                        ))
                    ]),
                    smallButton(_('Import YAML'), function() {
                        openEditor({ document: starterDocument(), name: '', description: '' }, { newTemplate: true, yamlImport: true });
                    }),
                    smallButton(_('New visual template'), function() {
                        openEditor({ document: starterDocument(), name: '', description: '' }, { newTemplate: true });
                    }, 'btn cbi-button-add')
                ])
            ]),
            cards.length ? E('div', {
                'style': 'display: grid; grid-template-columns: repeat(auto-fit,minmax(330px,1fr)); gap: 12px;'
            }, cards) : E('div', {
                'style': 'padding: 24px; border: 1px dashed rgba(127,127,127,.4); text-align: center;'
            }, _('No templates are available.')),
            legacySection,
            catalog.trash_count ? E('p', { 'class': 'cbi-section-descr', 'style': 'margin-top: 14px;' }, _(
                '%s deleted template snapshot(s) are retained in protected router storage for recovery.'
            ).format(catalog.trash_count)) : ''
        ]);
    },

    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
